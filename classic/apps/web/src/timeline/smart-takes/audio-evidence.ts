/** Platform decoding only; the canonical take capability owns acoustic decisions. */
import type { EditorCore } from "@/core";
import { decodeAudioToFloat32 } from "@/media/audio";
import { getClipAudioTiming } from "@/media/audio-sync";
import { extractCompactAudioFeatures } from "../audio-silence-analysis";
import type { TakeAudioEvidence } from "./types";

export async function collectTakeAudioEvidence({
	editor,
	elementIds,
	signal,
	boundedFrames = false,
}: {
	editor: EditorCore;
	elementIds: string[];
	signal: AbortSignal;
	boundedFrames?: boolean;
}): Promise<TakeAudioEvidence[]> {
	const scene = editor.scenes.getActiveScene();
	const assets = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const decoded = new Map<
		string,
		Awaited<ReturnType<typeof decodeAudioToFloat32>>
	>();
	const evidence: TakeAudioEvidence[] = [];
	const selectedSeconds = scene.tracks.main.elements
		.filter((e) => elementIds.includes(e.id))
		.reduce((sum, e) => sum + e.duration / 120000, 0);
	const minFrame = boundedFrames ? Math.max(0.01, selectedSeconds / 340000) : 0;
	for (const clip of scene.tracks.main.elements) {
		if (clip.type !== "video" || !elementIds.includes(clip.id)) continue;
		signal.throwIfAborted();
		const asset = assets.get(clip.mediaId);
		if (!asset || (!asset.file && !asset.url))
			throw new Error(
				"Source audio is unavailable. Relink the media before running Smart takes.",
			);
		let audio = decoded.get(asset.id);
		if (!audio) {
			audio = await decodeAudioToFloat32({
				audioBlob: asset.file,
				url: asset.url,
				channelMix: "max-magnitude",
				signal,
			});
			decoded.set(asset.id, audio);
		}
		const timing = getClipAudioTiming(clip);
		const rate = clip.retime?.rate ?? 1;
		const frames = await extractCompactAudioFeatures({
			samples: audio.samples,
			sampleRate: audio.sampleRate,
			sourceStartSeconds: timing.trimStart,
			sourceEndSeconds: timing.trimStart + timing.duration * rate,
			playbackRate: rate,
			frameDurationSeconds: Math.max(minFrame, 0.01 * Math.min(1, rate)),
			yieldControl: async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				signal.throwIfAborted();
			},
		});
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
