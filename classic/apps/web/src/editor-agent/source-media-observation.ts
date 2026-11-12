import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { openAudioWindowReader } from "@/media/audio-window";
import type { MediaAsset } from "@/media/types";
import { z } from "zod";

const inputSchema = z
	.object({
		projectId: z.string(),
		expectedRevision: z.number().int().nonnegative(),
		mediaId: z.string(),
		observation: z.discriminatedUnion("mode", [
			z.object({ mode: z.literal("image") }).strict(),
			z
				.object({
					mode: z.literal("audio"),
					startMs: z.number().int().nonnegative(),
					endMs: z.number().int().max(86_400_000),
					transcribe: z.boolean(),
				})
				.strict(),
		]),
	})
	.strict();

async function decodeImage({
	asset,
	signal,
}: {
	asset: MediaAsset;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	const localUrl = asset.file && URL.createObjectURL(asset.file);
	const image = new Image();
	try {
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", cancel);
				image.onload = image.onerror = null;
			};
			const fail = () => {
				cleanup();
				reject(new Error("Source image could not be decoded"));
			};
			const cancel = () => {
				cleanup();
				reject(signal.reason);
			};
			const timer = setTimeout(fail, 15_000);
			signal.addEventListener("abort", cancel, { once: true });
			image.onload = () => {
				cleanup();
				resolve();
			};
			image.onerror = fail;
			image.src = localUrl || asset.url!;
		});
		signal.throwIfAborted();
		const { naturalWidth: width, naturalHeight: height } = image;
		if (!width || !height || width > 32768 || height > 32768)
			throw new Error("Unsupported source image dimensions");
		const scale = Math.min(1, 1024 / Math.max(width, height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(width * scale));
		canvas.height = Math.max(1, Math.round(height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Source image canvas is unavailable");
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, "image/jpeg", 0.78),
		);
		signal.throwIfAborted();
		if (!blob || blob.type !== "image/jpeg" || blob.size > 350_000)
			throw new Error("Source image exceeds the observation budget");
		return { width, height, bytes: new Uint8Array(await blob.arrayBuffer()) };
	} finally {
		image.removeAttribute("src");
		if (localUrl) URL.revokeObjectURL(localUrl);
	}
}

export async function performProjectMediaObservation({
	effect,
	editor,
	accountId,
	signal,
}: {
	effect: EditingAgentHostEffect;
	editor: EditorCore;
	accountId: string;
	signal: AbortSignal;
}): Promise<EditingAgentHostResult> {
	try {
		const input = inputSchema.parse(effect.request);
		const { projectId, mediaId, observation } = input;
		const source = () =>
			editor.media.getAssets().find((item) => item.id === mediaId);
		const asset = source();
		const check = () => {
			signal.throwIfAborted();
			if (
				effect.adapter !== "projectMediaObservation" ||
				effect.projectId !== projectId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				(window.__opencutAccountId ?? "local") !== accountId ||
				editor.command.getCanonicalRevision() !== input.expectedRevision ||
				source() !== asset
			)
				throw new Error(
					"Source observation account, project, media or revision changed",
				);
		};
		check();
		if (!asset || (!asset.file && !asset.url))
			throw new Error("The attached project media is offline");
		const scope = { projectId, mediaId, revision: input.expectedRevision };
		if (observation.mode === "image") {
			if (asset.type !== "image") throw new Error("Select a project image");
			const { width, height, bytes } = await decodeImage({ asset, signal });
			check();
			const { artifactId } = editor.command.storeEditingAttachment({
				bytes,
				mimeType: "image/jpeg",
				filename: "project-image-observation.jpg",
			});
			return {
				type: "success",
				data: {
					...scope,
					evidence: {
						mode: "image",
						width,
						height,
						artifactId,
					},
				},
			};
		}
		const { startMs, endMs: requestedEnd, transcribe } = observation;
		if (
			(asset.type !== "audio" && asset.type !== "video") ||
			requestedEnd <= startMs ||
			requestedEnd - startMs > 30_000
		)
			throw new Error("Select an audio or video source and at most 30 seconds");
		const reader = await openAudioWindowReader({ asset, signal });
		try {
			const durationMs = Math.floor((await reader.duration()) * 1000);
			const endMs = Math.min(requestedEnd, durationMs);
			check();
			if (
				!Number.isFinite(durationMs) ||
				durationMs > 86_400_000 ||
				endMs <= startMs
			)
				throw new Error("Requested range is outside the source audio");
			const pcm = await reader.read({
				start: startMs / 1000,
				end: endMs / 1000,
			});
			check();
			let sum = 0,
				peak = 0;
			for (const sample of pcm) {
				const level = Number.isFinite(sample)
					? Math.min(1, Math.abs(sample))
					: 0;
				sum += level * level;
				peak = Math.max(peak, level);
			}
			const rms = Math.min(peak, Math.sqrt(sum / pcm.length));
			let transcript: string | null = null;
			if (transcribe) {
				if (peak === 0) {
					transcript = "";
				} else {
					const { transcribeAudioWindows } =
						await import("@/transcription/windows");
					const result = await transcribeAudioWindows({
						duration: (endMs - startMs) / 1000,
						signal,
						language: "auto",
						browserModel: "whisper-large-v3-turbo",
						load: async () => pcm,
					});
					// Keep the reply within the Rust UTF-8 limit, even for multibyte scripts.
					transcript = Array.from(result.text).slice(0, 3000).join("");
				}
			}
			check();
			return {
				type: "success",
				data: {
					...scope,
					evidence: {
						mode: "audio",
						startMs,
						endMs,
						durationMs,
						rms,
						peak,
						transcript,
					},
				},
			};
		} finally {
			reader.close();
		}
	} catch (error) {
		return {
			type: "rejected",
			message:
				error instanceof Error ? error.message : "Source observation failed",
		};
	}
}
