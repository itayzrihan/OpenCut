import { mockFetch } from "@/test-support/mock-fetch";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope } from "@/accounts/server";
import {
	readExternalSettings,
	saveExternalSettings,
	publicExternalSettings,
	requestExternalTranscript,
	boundedBytes,
} from "./external-server";
let root: string;
let previous: string | undefined;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-transcription-"));
	previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
});
afterEach(async () => {
	if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
	else process.env.OPENCUT_ACCOUNTS_DIR = previous;
	await rm(root, { recursive: true, force: true });
});
const account = (id: string, run: () => Promise<unknown>) =>
	accountScope.run({ id, login: id, displayName: id }, run);
const input = {
	endpoint: "https://api.example.com/v1/audio/transcriptions",
	model: "whisper-1",
	apiKey: "test-secret",
};
test("credentials are account-scoped, private and never included in public settings", async () => {
	await account("alice", async () => {
		const view = await saveExternalSettings(input);
		expect(view.configured).toBe(true);
		expect(JSON.stringify(view)).not.toContain("test-secret");
		expect(
			(await stat(join(root, "transcription-credentials", "alice.json"))).mode &
				0o777,
		).toBe(0o600);
		const before = await readExternalSettings();
		const updated = await saveExternalSettings({
			...input,
			apiKey: "rotated-secret",
		});
		expect(updated.id).toBe(before!.id);
		await expect(
			saveExternalSettings({
				...input,
				endpoint: "https://different.example.com/transcriptions",
				apiKey: "",
			}),
		).rejects.toThrow("Enter an API key");
		expect(publicExternalSettings(await readExternalSettings()).endpoint).toBe(
			input.endpoint,
		);
	});
	await account("bob", async () => {
		expect(await readExternalSettings()).toBeNull();
	});
});
test("invalid endpoints fail before saving credentials", async () => {
	await account("alice", async () => {
		for (const endpoint of [
			"http://api.example.com/transcriptions",
			"https://user:password@api.example.com/transcriptions",
			"https://api.example.com/transcriptions?token=secret",
		])
			await expect(
				saveExternalSettings({ ...input, endpoint }),
			).rejects.toThrow();
		expect(await readExternalSettings()).toBeNull();
	});
});
test("external adapter sends bounded WAV and requests actual word timestamps", async () => {
	let called = false;
	const result = await requestExternalTranscript({
		config: { ...input, id: "version" },
		audio: new Blob(["wav"], { type: "audio/wav" }),
		language: "he",
		signal: new AbortController().signal,
		fetcher: mockFetch(async (url, options) => {
			called = true;
			expect(url).toBe(input.endpoint);
			expect(options?.redirect).toBe("error");
			expect(new Headers(options?.headers).get("Authorization")).toBe(
				"Bearer test-secret",
			);
			const form = options!.body as FormData;
			expect(form.get("timestamp_granularities[]")).toBe("word");
			expect(form.get("response_format")).toBe("verbose_json");
			expect(form.get("language")).toBe("he");
			return Response.json({
				text: "שלום",
				words: [{ word: " שלום ", start: 1, end: 2 }],
				language: "he",
			});
		}),
	});
	expect(called).toBe(true);
	expect(result.words).toEqual([{ text: "שלום", start: 1, end: 2 }]);
});
test("text-only models, invalid times and upstream authentication fail explicitly", async () => {
	const base = {
		config: { ...input, id: "version" },
		audio: new Blob(["wav"]),
		language: "auto",
		signal: new AbortController().signal,
	};
	await expect(
		requestExternalTranscript({
			...base,
			fetcher: mockFetch(async () => Response.json({ text: "missing times" })),
		}),
	).rejects.toThrow("word timestamps");
	await expect(
		requestExternalTranscript({
			...base,
			fetcher: mockFetch(async () =>
				Response.json({
					text: "invalid",
					words: [{ word: "invalid", start: 5, end: 4 }],
				})),
		}),
	).rejects.toThrow();
	await expect(
		requestExternalTranscript({
			...base,
			fetcher: mockFetch(async () =>
				new Response("private provider body", { status: 401 })),
		}),
	).rejects.toThrow("rejected the key");
	await expect(
		requestExternalTranscript({
			...base,
			audio: new Blob([new Uint8Array(3_000_000)]),
		}),
	).rejects.toThrow("bounded");
	await expect(
		boundedBytes({ body: new Response(new Uint8Array(10)).body, limit: 9 }),
	).rejects.toThrow("size limit");
});
