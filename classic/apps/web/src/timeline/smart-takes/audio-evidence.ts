/** Platform decoding only; the canonical take capability owns acoustic decisions. */
import { resolveUnifiedAnglesAudioAsset } from "@/media/unified-angles";
import type { EditorCore } from "@/core";
import {
	openAudioWindowReader,
	SPEECH_SAMPLE_RATE,
} from "@/media/audio-window";
import type { AudioAnalysisFrame } from "opencut-wasm";
import { getClipAudioTiming } from "@/media/audio-sync";
import { extractCompactAudioFeatures } from "../audio-silence-analysis";
import type { TakeAudioEvidence } from "./types";
import {
	audioCheckpointKey,
	type AudioCheckpointStore,
} from "./audio-checkpoints";

export async function collectTakeAudioEvidence({
	editor,
	elementIds,
	sourceClips,
	signal,
	boundedFrames = false,
	onProgress,
	checkpoint,
	assertCurrent,
}: {
	editor: EditorCore;
	elementIds: string[];
	sourceClips?: import("@/timeline/audio-state").AudioCapableElement[];
	signal: AbortSignal;
	boundedFrames?: boolean;
	onProgress?: (seconds: number, total: number) => void;
	checkpoint?: { key: string; store: AudioCheckpointStore };
	assertCurrent?: () => void;
}): Promise<TakeAudioEvidence[]> {
	const scene = editor.scenes.getActiveScene();
	const assets = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const evidence: TakeAudioEvidence[] = [];
	const clips = sourceClips ?? scene.tracks.main.elements;
	const selectedIds = new Set(elementIds);
	const selectedSeconds = clips
		.filter((e) => selectedIds.has(e.id))
		.reduce((sum, e) => sum + e.duration / 120000, 0);
	const minFrame = boundedFrames ? Math.max(0.01, selectedSeconds / 340000) : 0;
	for (const clip of clips) {
		if (
			(clip.type !== "video" && clip.type !== "audio") ||
			!selectedIds.has(clip.id)
		)
			continue;
		signal.throwIfAborted();
		// Library audio has no media binding; Rust retains unknown coverage.
		if (!("mediaId" in clip)) continue;
		const referenced = assets.get(clip.mediaId);
		const asset = referenced
			? resolveUnifiedAnglesAudioAsset({ asset: referenced, mediaMap: assets })
			: undefined;
		if (!asset || (!asset.file && !asset.url))
			throw new Error(
				"Source audio is unavailable. Relink the media before running Smart takes.",
			);
		const timing = getClipAudioTiming(clip);
		const rate = clip.retime?.rate ?? 1;
		const frameDurationSeconds = Math.max(
			minFrame * rate,
			0.01 * Math.min(1, rate),
		);
		const frameSize = Math.max(
			1,
			Math.round(SPEECH_SAMPLE_RATE * frameDurationSeconds),
		);
		const windowSeconds =
			(Math.max(1, Math.floor((30 * SPEECH_SAMPLE_RATE) / frameSize)) *
				frameSize) /
			SPEECH_SAMPLE_RATE;
		const frames: AudioAnalysisFrame[] = [];
		{
			const sourceEnd = timing.trimStart + timing.duration * rate;
			for (
				let start = timing.trimStart;
				start < sourceEnd;
				start += windowSeconds
			) {
				signal.throwIfAborted();
				assertCurrent?.();
				const end = Math.min(sourceEnd, start + windowSeconds);
				const duration =
					Math.ceil((end - start) * SPEECH_SAMPLE_RATE) /
					SPEECH_SAMPLE_RATE /
					rate;
				const key = checkpoint
					? await audioCheckpointKey({
							value: {
								parent: checkpoint.key,
								clipId: clip.id,
								assetId: asset.id,
								size: asset.size ?? asset.file?.size,
								lastModified: asset.lastModified ?? asset.file?.lastModified,
								bindingRevision: asset.bindingRevision ?? 0,
								sourcePath: asset.sourcePath,
								sourceDuration: asset.duration,
								timing,
								rate,
								start,
								end,
								frameSize,
							},
						})
					: undefined;
				let windowFrames =
					key && checkpoint
						? await checkpoint.store.read({ key, duration })
						: undefined;
				signal.throwIfAborted();
				assertCurrent?.();
				if (!windowFrames) {
					// Bound decoder/source caches to this window as well as the PCM buffer.
					const reader = await openAudioWindowReader({ asset, signal });
					let samples: Float32Array;
					try {
						samples = await reader.read({
							start,
							end,
							missing: "unknown",
							channelMix: "max-magnitude",
						});
					} finally {
						reader.close();
					}
					windowFrames = await extractCompactAudioFeatures({
						samples,
						sampleRate: SPEECH_SAMPLE_RATE,
						sourceStartSeconds: 0,
						sourceEndSeconds: end - start,
						playbackRate: rate,
						frameDurationSeconds,
						yieldControl: async () => {
							await new Promise<void>((resolve) => setTimeout(resolve, 0));
							signal.throwIfAborted();
						},
					});
					signal.throwIfAborted();
					assertCurrent?.();
					windowFrames = windowFrames.filter((f) =>
						[f.start, f.end, f.rms, f.peak, f.zeroCrossingRate ?? 0].every(
							Number.isFinite,
						),
					);
					if (key && checkpoint)
						await checkpoint.store.write({
							key,
							duration,
							frames: windowFrames,
						});
				}
				signal.throwIfAborted();
				assertCurrent?.();
				// Decoded PCM (including cached windows) may include a padded final
				// sample. Keep evidence inside the requested clock interval before
				// joining windows, so padding cannot overlap the following window.
				const windowDuration = (end - start) / rate;
				for (const frame of windowFrames) {
					const frameStart = Math.max(0, Math.min(frame.start, windowDuration));
					const frameEnd = Math.max(0, Math.min(frame.end, windowDuration));
					if (frameEnd <= frameStart) continue;
					const translatedStart =
						frameStart + (start - timing.trimStart) / rate;
					const translatedEnd = frameEnd + (start - timing.trimStart) / rate;
					// Sub-sample padding can collapse to one clock value after adding
					// a long timeline offset, even when its local endpoints differ.
					if (translatedEnd <= translatedStart) continue;
					frames.push({
						...frame,
						start: translatedStart,
						end: translatedEnd,
					});
				}
				onProgress?.((end - timing.trimStart) / rate, timing.duration);
			}
		}
		const offset = timing.startTime - clip.startTime / 120000;
		evidence.push({
			clipId: clip.id,
			// Missing/non-finite decoded samples must become missing coverage, not
			// JSON null numeric fields or false silence. Rust then reports uncertainty.
			frames: frames
				.filter((frame) =>
					[
						frame.start,
						frame.end,
						frame.rms,
						frame.peak,
						frame.zeroCrossingRate ?? 0,
					].every(Number.isFinite),
				)
				.map((frame) => ({
					...frame,
					zeroCrossingRate: frame.zeroCrossingRate ?? 0,
					start: frame.start + offset,
					end: frame.end + offset,
				})),
		});
	}
	signal.throwIfAborted();
	return evidence;
}
