/** Account-scoped host IO. Secrets never enter the editor document or browser storage. */
import { accountsRoot, requireAccount } from "@/accounts/server";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { TranscriptionResult } from "./types";
const settingsSchema = z
	.object({
		endpoint: z.string().url().max(2048),
		model: z.string().trim().min(1).max(160),
		apiKey: z
			.string()
			.trim()
			.max(4096)
			.refine((value) => Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127))
			.optional(),
	})
	.strict();
export interface ExternalSettings {
	id: string;
	endpoint: string;
	model: string;
	apiKey: string;
}
const defaults = {
	endpoint: "https://api.openai.com/v1/audio/transcriptions",
	model: "whisper-1",
};
function settingsPath() {
	return join(
		accountsRoot(),
		"transcription-credentials",
		`${requireAccount().id}.json`,
	);
}
export async function readExternalSettings(): Promise<ExternalSettings | null> {
	try {
		return JSON.parse(await readFile(settingsPath(), "utf8"));
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") return null;
		throw e;
	}
}
export function publicExternalSettings(config: ExternalSettings | null) {
	return {
		endpoint: config?.endpoint ?? defaults.endpoint,
		model: config?.model ?? defaults.model,
		id: config?.id,
		configured: !!config?.apiKey,
	};
}
export async function saveExternalSettings(input: unknown) {
	const next = settingsSchema.parse(input);
	const url = new URL(next.endpoint);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.search
	)
		throw new Error(
			"Use an HTTPS transcription endpoint without credentials, query parameters or fragments",
		);
	const old = await readExternalSettings();
	// Never forward a retained credential to a newly selected destination.
	const apiKey =
		next.apiKey || (old?.endpoint === next.endpoint ? old.apiKey : "");
	if (!apiKey) throw new Error("Enter an API key for this endpoint");
	const config: ExternalSettings = {
		...next,
		apiKey,
		id: createHash("sha256")
			.update(JSON.stringify([next.endpoint, next.model]))
			.digest("hex"),
	};
	const path = settingsPath();
	await mkdir(join(accountsRoot(), "transcription-credentials"), {
		recursive: true,
		mode: 0o700,
	});
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, JSON.stringify(config), { mode: 0o600 });
	await rename(temp, path);
	return publicExternalSettings(config);
}
export async function boundedBytes({
	body,
	limit,
}: {
	body: ReadableStream<Uint8Array> | null;
	limit: number;
}) {
	if (!body) throw new Error("Missing request body");
	const reader = body.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit) {
				await reader.cancel();
				throw new Error("Transcription payload exceeds its size limit");
			}
			parts.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const all = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		all.set(part, at);
		at += part.length;
	}
	return all;
}
const timed = z
	.object({
		word: z.string().optional(),
		text: z.string().optional(),
		start: z.number().finite().nonnegative().max(90),
		end: z.number().finite().nonnegative().max(90),
	})
	.refine((v) => v.end >= v.start);
const resultSchema = z.object({
	text: z.string().max(200000),
	language: z.string().optional(),
	words: z.array(timed).max(10000).optional(),
});
export async function requestExternalTranscript({
	config,
	audio,
	language,
	signal,
	fetcher = fetch,
}: {
	config: ExternalSettings;
	audio: Blob;
	language: string;
	signal: AbortSignal;
	fetcher?: typeof fetch;
}): Promise<TranscriptionResult> {
	if (audio.size === 0 || audio.size > 2_880_044)
		throw new Error("Expected a bounded 16 kHz audio window");
	const form = new FormData();
	form.append("file", audio, "section.wav");
	form.append("model", config.model);
	form.append("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "word");
	if (language !== "auto") form.append("language", language);
	const response = await fetcher(config.endpoint, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}` },
		body: form,
		signal: AbortSignal.any([signal, AbortSignal.timeout(240000)]),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new ExternalProviderError(response.status);
	}
	const bytes = await boundedBytes({ body: response.body, limit: 1_000_000 });
	const result = resultSchema.parse(
		JSON.parse(new TextDecoder().decode(bytes)),
	);
	const words = (result.words ?? [])
		.map((w) => ({
			text: (w.word ?? w.text ?? "").trim(),
			start: w.start,
			end: w.end,
		}))
		.filter((w) => w.text.length > 0);
	if (result.text.trim() && !words.length)
		throw new Error(
			"The API model must support verbose_json with word timestamps. Use whisper-1 or a compatible model.",
		);
	return {
		text: result.text,
		words,
		segments: words,
		language: result.language ?? language,
	};
}
export class ExternalProviderError extends Error {
	constructor(public status: number) {
		super(
			status === 401 || status === 403
				? "Transcription API rejected the key. Check API settings."
				: status === 429
					? "Transcription API rate or quota limit reached."
					: `Transcription API request failed (${status}).`,
		);
	}
}
