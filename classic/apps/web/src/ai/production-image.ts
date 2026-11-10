import { generateConnectedImage, readLocalProvider } from "./local-connection";
import { api, fileUrl } from "@/generative/client";
import { REPLACE_IMAGE_MODEL } from "@/generative/replace-model";
import type { DirectorJob, DirectorStatus } from "@/generative/types";
import { useDirectorReviewFocus } from "@/generative/review-focus";

async function readOwnedImage({
	projectId,
	id,
	signal,
	maximumBytes = 2_000_000,
}: {
	projectId: string;
	id: string;
	signal: AbortSignal;
	maximumBytes?: number;
}) {
	const response = await fetch(fileUrl({ projectId, id }), {
		credentials: "same-origin",
		signal,
	});
	if (!response.ok) throw new Error("The owned reference image is unavailable");
	const type = response.headers.get("Content-Type")?.split(";")[0] ?? "";
	if (!["image/png", "image/jpeg", "image/webp"].includes(type))
		throw new Error("The reference must be a PNG, JPEG or WebP image");
	const declared = Number(response.headers.get("Content-Length"));
	if (declared > maximumBytes)
		throw new Error("The image exceeds its byte limit");
	if (!response.body) throw new Error("Reference bytes are unavailable");
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			size += item.value.length;
			if (size > maximumBytes) {
				await reader.cancel();
				throw new Error("The image exceeds its byte limit");
			}
			parts.push(item.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return {
		blob: new Blob([bytes], { type }),
		url:
			`data:${type};base64,` +
			btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")),
	};
}
function pause(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, 1500);
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Image review cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
/** The caller has displayed the exact per-slot prompt and obtained human generation approval.
 * OpenRouter still requires the separate human PIN in its existing job review. */
export async function generateProductionReference({
	projectId,
	operationId,
	prompt,
	referenceIds = [],
	signal,
	confirmed,
	provider: chosenProvider,
	model = REPLACE_IMAGE_MODEL,
}: {
	projectId: string;
	operationId: string;
	prompt: string;
	referenceIds?: string[];
	signal: AbortSignal;
	confirmed: true;
	model?: string;
	provider?: "codex" | "openrouter";
}): Promise<{ blob: Blob; mimeType: string }> {
	if (confirmed !== true)
		throw new Error("Review the image prompts before generation");
	const account = window.__opencutAccountId;
	const selected = readLocalProvider();
	const provider = chosenProvider ?? selected;
	const check = () => {
		signal.throwIfAborted();
		if (
			!account ||
			window.__opencutAccountId !== account ||
			readLocalProvider() !== selected
		)
			throw new Error("The image account or provider changed");
	};
	check();
	if (provider === "claude")
		throw new Error(
			"Claude does not generate images. Choose Codex or OpenRouter in Agent settings.",
		);
	if (provider === "codex") {
		if (referenceIds.length > 4)
			throw new Error("Choose up to four reference images");
		const references = await Promise.all(
			referenceIds.map((id) => readOwnedImage({ projectId, id, signal })),
		);
		check();
		return generateConnectedImage({
			projectId,
			operationId,
			prompt,
			references: references.map((r) => r.url),
			signal,
			confirmed: true,
		});
	}
	// Prepare is idempotent and cannot call the provider. Only the visual PIN form may approve.
	const prepared = await api<{ job: DirectorJob }>({
		projectId,
		action: "prepare",
		signal,
		data: {
			request: {
				projectId,
				operationId,
				kind: "storyboard",
				model,
				referenceImage: true,
				prompt,
				referenceIds,
			},
		},
	});
	check();
	useDirectorReviewFocus.getState().reveal({
		accountId: account!,
		projectId,
		jobId: prepared.job.id,
		surface: "agent",
		batchId: prepared.job.batchId,
	});
	let job = prepared.job;
	const deadline = Date.now() + 15 * 60_000;
	while (job.status !== "ready") {
		check();
		if (
			["error", "uncertain", "rejected", "session_expired"].includes(job.status)
		)
			throw new Error(
				job.message ||
					"Image generation did not complete; no automatic retry was sent",
			);
		if (Date.now() > deadline)
			throw new Error(
				"The image review is still pending. Reopen the same operation to check it; no duplicate request was sent.",
			);
		await pause(signal);
		const state = await api<DirectorStatus>({ projectId, signal });
		check();
		const current = state.jobs.find((j) => j.id === job.id);
		if (!current) throw new Error("The prepared image job is unavailable");
		job = current;
	}
	if (!job.output) throw new Error("The completed image has no output");
	const output = await readOwnedImage({
		projectId,
		id: job.output.id,
		signal,
		maximumBytes: 16_000_000,
	});
	check();
	return { blob: output.blob, mimeType: output.blob.type };
}

/** Freeze all exact image requests before the human PIN authorizes the batch. */
export async function prepareProductionReferenceBatch({
	projectId,
	items,
	signal,
	provider: chosenProvider,
	model = REPLACE_IMAGE_MODEL,
}: {
	projectId: string;
	items: Array<{
		operationId: string;
		prompt: string;
		referenceIds?: string[];
	}>;
	signal: AbortSignal;
	model?: string;
	provider?: "codex" | "openrouter";
}) {
	if (items.length < 1 || items.length > 10)
		throw new Error("Review between one and ten reference images");
	const selected = readLocalProvider();
	const provider = chosenProvider ?? selected;
	if (provider === "codex") return;
	if (provider === "claude")
		throw new Error("Choose Codex or OpenRouter for image generation");
	const accountId = window.__opencutAccountId;
	if (!accountId) throw new Error("Sign in first");
	const jobs: DirectorJob[] = [];
	for (const item of items) {
		signal.throwIfAborted();
		if (
			window.__opencutAccountId !== accountId ||
			readLocalProvider() !== selected
		)
			throw new Error("The image account or provider changed");
		const { job } = await api<{ job: DirectorJob }>({
			projectId,
			action: "prepare",
			signal,
			data: {
				request: {
					projectId,
					...item,
					referenceIds: item.referenceIds ?? [],
					kind: "storyboard",
					model,
					referenceImage: true,
				},
			},
		});
		jobs.push(job);
	}
	const ids = jobs.map((job) => ({ id: job.id, digest: job.digest }));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([projectId, ids])),
	);
	const id = Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	)
		.join("")
		.slice(0, 32);
	await api({
		projectId,
		action: "prepare-batch",
		signal,
		data: { batch: { id, kind: "images", jobs: ids } },
	});
	if (
		window.__opencutAccountId !== accountId ||
		readLocalProvider() !== selected
	)
		throw new Error("The image account or provider changed");
	useDirectorReviewFocus.getState().reveal({
		accountId,
		projectId,
		jobId: jobs[0].id,
		batchId: id,
		surface: "agent",
	});
	return { id, accountId };
}

/** Explicit user cancellation stops queued jobs, never promises reversal of accepted calls. */
export async function cancelProductionReferenceBatch({
	projectId,
	id,
	accountId,
}: {
	projectId: string;
	id: string;
	accountId: string;
}) {
	const response = await fetch("/api/generative", {
		method: "POST",
		credentials: "same-origin",
		cache: "no-store",
		headers: {
			"Content-Type": "application/json",
			"X-OpenCut-Account": accountId,
		},
		signal: AbortSignal.timeout(10_000),
		body: JSON.stringify({ projectId, action: "cancel-batch", id }),
	});
	if (!response.ok)
		throw new Error(
			"Queued image cancellation could not be confirmed. Reopen the batch review to inspect its status.",
		);
}
