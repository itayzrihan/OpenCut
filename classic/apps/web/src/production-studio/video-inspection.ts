import type { EditorCore } from "@/core";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { z } from "zod";

function waitForVideo({
	video,
	event,
	action,
	signal,
}: {
	video: HTMLVideoElement;
	event: "loadeddata" | "seeked";
	action: () => void;
	signal: AbortSignal;
}): Promise<void> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			video.removeEventListener(event, ready);
			video.removeEventListener("error", failed);
			signal.removeEventListener("abort", cancelled);
		};
		const ready = () => {
			cleanup();
			resolve();
		};
		const failed = () => {
			cleanup();
			reject(
				new Error("This source video could not be decoded in this browser"),
			);
		};
		const cancelled = () => {
			cleanup();
			reject(new Error("Video inspection cancelled"));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Source video decoding timed out"));
		}, 15_000);
		video.addEventListener(event, ready, { once: true });
		video.addEventListener("error", failed, { once: true });
		signal.addEventListener("abort", cancelled, { once: true });
		try {
			action();
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

/** Browser-only source decoding. No upload, provider, or arbitrary source URL. */
export async function performProductionVideoInspection({
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
	let video: HTMLVideoElement | undefined, ownedUrl: string | undefined;
	try {
		const input = z
			.object({
				projectId: z.string(),
				expectedRevision: z.number().int().nonnegative(),
				mediaId: z.string(),
				timesMs: z
					.array(z.number().int().nonnegative().max(86_399_999))
					.min(1)
					.max(8),
			})
			.strict()
			.parse(effect.request);
		const source = editor.media
			.getAssets()
			.find((asset) => asset.id === input.mediaId);
		const check = () => {
			signal.throwIfAborted();
			if (
				effect.adapter !== "productionVideoFrames" ||
				effect.projectId !== input.projectId ||
				editor.project.getActiveOrNull()?.metadata.id !== input.projectId ||
				(window.__opencutAccountId ?? "local") !== accountId ||
				editor.command.getCanonicalRevision() !== input.expectedRevision ||
				editor.media.getAssets().find((asset) => asset.id === input.mediaId) !==
					source
			)
				throw new Error(
					"The video inspection account, source, project or revision changed",
				);
		};
		check();
		if (
			!source ||
			source.type !== "video" ||
			(!source.file && !source.url) ||
			new Set(input.timesMs).size !== input.timesMs.length
		)
			throw new Error(
				"Choose an available project video and distinct sample timestamps",
			);
		const src = source.file
			? (ownedUrl = URL.createObjectURL(source.file))
			: source.url!;
		video = document.createElement("video");
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		await waitForVideo({
			video,
			event: "loadeddata",
			action: () => {
				video!.src = src;
			},
			signal,
		});
		check();
		const durationMs = Math.round(video.duration * 1000),
			width = video.videoWidth,
			height = video.videoHeight;
		if (
			!Number.isFinite(durationMs) ||
			durationMs <= 0 ||
			durationMs > 86_400_000 ||
			!width ||
			!height ||
			width > 32768 ||
			height > 32768 ||
			input.timesMs.some((time) => time >= durationMs)
		)
			throw new Error(
				"Requested source timestamps exceed this decoded video's duration",
			);
		const samples: Array<{ timeMs: number; bytes: Uint8Array }> = [];
		for (const timeMs of input.timesMs) {
			check();
			if (Math.abs(video.currentTime - timeMs / 1000) > 0.0001)
				await waitForVideo({
					video,
					event: "seeked",
					action: () => {
						video!.currentTime = timeMs / 1000;
					},
					signal,
				});
			check();
			const scale = Math.min(1, 640 / Math.max(width, height));
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Video frame canvas is unavailable");
			context.drawImage(video, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise<Blob>((resolve, reject) =>
				canvas.toBlob(
					(value) =>
						value
							? resolve(value)
							: reject(new Error("Could not encode video evidence")),
					"image/jpeg",
					0.72,
				),
			);
			if (!blob.size || blob.size > 180_000)
				throw new Error("A video frame exceeds the bounded evidence budget");
			samples.push({ timeMs, bytes: new Uint8Array(await blob.arrayBuffer()) });
		}
		check();
		const frames = samples.map(({ timeMs, bytes }) => ({
			timeMs,
			artifactId: editor.command.storeEditingAttachment({
				bytes,
				mimeType: "image/jpeg",
				filename: `source-frame-${timeMs}ms.jpg`,
			}).artifactId,
		}));
		return {
			type: "success",
			data: {
				projectId: input.projectId,
				revision: input.expectedRevision,
				mediaId: input.mediaId,
				durationMs,
				width,
				height,
				frames,
			},
		};
	} catch (error) {
		return {
			type: "rejected",
			message:
				error instanceof Error ? error.message : "Video inspection failed",
		};
	} finally {
		if (video) {
			video.removeAttribute("src");
			video.load();
		}
		if (ownedUrl) URL.revokeObjectURL(ownedUrl);
	}
}
