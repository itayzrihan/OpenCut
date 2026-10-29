/** Browser decoding/selection adapter; all silence decisions run in shared Rust. */
import { analyzeSmartAudioSilence } from "opencut-wasm";
import type { EditorCore } from "@/core";
import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import {
	openAudioWindowReader,
	SPEECH_SAMPLE_RATE,
} from "@/media/audio-window";
import { getClipAudioTiming } from "@/media/audio-sync";
import { resolveUnifiedAnglesAudioAsset } from "@/media/unified-angles";
import { doesElementHaveEnabledAudio } from "./audio-separation";
import { isElementMuted } from "./audio-state";
import {
	clampAudioMinSilenceSeconds,
	DEFAULT_AUDIO_MIN_SILENCE_SECONDS,
	extractCompactAudioFeatures,
} from "./audio-silence-analysis";
import {
	removeSilenceRangesFromTracks,
	type TimelineTimeRange,
} from "./cut-silence";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";
import type { TimelineElement } from "./types";

export async function removeSmartSilence({
	editor,
	minSilenceSeconds = DEFAULT_AUDIO_MIN_SILENCE_SECONDS,
	signal,
}: {
	editor: EditorCore;
	minSilenceSeconds?: number;
	signal?: AbortSignal;
}): Promise<void> {
	signal?.throwIfAborted();
	await editor.command.enableCanonical();
	signal?.throwIfAborted();
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	if (scene.takeAssembly) {
		// Native cleanup maps archived audio evidence onto the live clips;
		// manual edits, source clocks and all alternatives survive.
		return editor.command.cleanSmartTakeSilence({ signal, minSilenceSeconds });
	}
	const before = scene.tracks;
	const revision = editor.command.getStateRevision();
	const selected = editor.timeline
		.getElementsWithTracks({
			elements: editor.selection.getSelectedElements(),
		})
		.filter(({ element }) => element.type === "video")
		.sort((a, b) => a.element.startTime - b.element.startTime);
	if (selected.length === 0) return;
	// A union of cuts from overlapping clips could remove another speaker's words.
	if (
		selected.some(
			({ track }, index) =>
				("locked" in track && track.locked === true) ||
				track.id !== selected[0].track.id ||
				(index > 0 &&
					selected[index - 1].element.startTime +
						selected[index - 1].element.duration >
						selected[index].element.startTime),
		)
	) {
		throw new Error(
			"Select non-overlapping video clips on one unlocked track for Smart audio cut.",
		);
	}
	const mediaById = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);
	const decodeSignal = signal ?? new AbortController().signal;
	const ranges: TimelineTimeRange[] = [];
	let analyzedClips = 0;
	const holdReasons = new Set<string>();
	// Every source participates, including manually corrected words. Protection
	// uses interval overlap, so words spanning clip boundaries are never lost.
	const words = before.overlay.flatMap((track) =>
		track.type === "text" ? (track.captionSource?.words ?? []) : [],
	);
	for (const { track, element } of selected) {
		signal?.throwIfAborted();
		if (element.type !== "video") continue;
		const referencedAsset = mediaById.get(element.mediaId);
		const asset = referencedAsset
			? resolveUnifiedAnglesAudioAsset({
					asset: referencedAsset,
					mediaMap: mediaById,
				})
			: null;
		if (
			!asset ||
			(!asset.file && !asset.url) ||
			track.type !== "video" ||
			track.muted ||
			isElementMuted({ element }) ||
			!doesElementHaveEnabledAudio({ element, mediaAsset: referencedAsset })
		) {
			throw new Error(
				"Every selected clip must have enabled, available source audio for Smart audio cut.",
			);
		}
		const playbackRate = element.retime?.rate ?? 1;
		if (
			!Number.isFinite(playbackRate) ||
			playbackRate < 0.01 ||
			playbackRate > 5
		)
			throw new Error(
				"Smart audio cut requires a supported forward playback rate.",
			);
		// Playback and export own the source/time mapping, including sync
		// offsets and missing source before zero. Analyze only its audible span;
		// any leading absent-source interval remains untouched.
		const audioTiming = getClipAudioTiming(element);
		const durationSeconds = audioTiming.duration;
		const startSeconds = audioTiming.startTime;
		const sourceStart = audioTiming.trimStart;
		if (durationSeconds <= 0) {
			analyzedClips += 1;
			holdReasons.add("no-audible-source-span");
			continue;
		}
		// A short cut can point deep into an hours-long source. Decode only its
		// audible interval, in frame-aligned windows, rather than retain the whole
		// recording's PCM. Unknown coverage reaches Rust unchanged as NaN.
		const frameDurationSeconds = 0.01 * Math.min(1, playbackRate);
		const frameSize = Math.max(
			1,
			Math.round(SPEECH_SAMPLE_RATE * frameDurationSeconds),
		);
		const windowSeconds =
			(Math.max(1, Math.floor((30 * SPEECH_SAMPLE_RATE) / frameSize)) *
				frameSize) /
			SPEECH_SAMPLE_RATE;
		const sourceEnd = sourceStart + durationSeconds * playbackRate;
		const frames: Awaited<ReturnType<typeof extractCompactAudioFeatures>> = [];
		for (let start = sourceStart; start < sourceEnd; start += windowSeconds) {
			signal?.throwIfAborted();
			const end = Math.min(sourceEnd, start + windowSeconds);
			const reader = await openAudioWindowReader({
				asset,
				signal: decodeSignal,
			});
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
			const windowFrames = await extractCompactAudioFeatures({
				samples,
				sampleRate: SPEECH_SAMPLE_RATE,
				sourceStartSeconds: 0,
				sourceEndSeconds: end - start,
				playbackRate,
				frameDurationSeconds,
				yieldControl: async () => {
					await new Promise<void>((resolve) => setTimeout(resolve, 0));
					signal?.throwIfAborted();
				},
			});
			const offset = (start - sourceStart) / playbackRate;
			for (const frame of windowFrames)
				frames.push({
					...frame,
					start: frame.start + offset,
					end: frame.end + offset,
				});
		}
		signal?.throwIfAborted();
		const result = analyzeSmartAudioSilence({
			frames,
			durationSeconds,
			transcriptWords: words.flatMap((word, wordIndex) =>
				word.end > startSeconds && word.start < startSeconds + durationSeconds
					? [
							{
								wordIndex,
								start: Math.max(0, word.start - startSeconds),
								end: Math.min(durationSeconds, word.end - startSeconds),
							},
						]
					: [],
			),
			settings: {
				minSilenceSeconds: clampAudioMinSilenceSeconds(minSilenceSeconds),
				speechPaddingSeconds: 0.12,
				bridgeGapSeconds: 0.18,
			},
		});
		analyzedClips += 1;
		if (result.diagnostics.safetyHoldReason)
			holdReasons.add(result.diagnostics.safetyHoldReason);
		for (const range of result.cutRanges) {
			if (
				!Number.isFinite(range.start) ||
				!Number.isFinite(range.end) ||
				range.start < 0 ||
				range.end > durationSeconds ||
				range.end <= range.start
			) {
				throw new Error(
					"Smart audio analysis returned an invalid cut interval.",
				);
			}
			ranges.push({
				startTime: mediaTime({
					ticks: Math.max(
						element.startTime,
						mediaTimeFromSeconds({ seconds: startSeconds + range.start }),
					),
				}),
				endTime: mediaTime({
					ticks: Math.min(
						element.startTime + element.duration,
						mediaTimeFromSeconds({ seconds: startSeconds + range.end }),
					),
				}),
			});
		}
	}
	signal?.throwIfAborted();
	if (
		editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id ||
		editor.scenes.getActiveSceneOrNull()?.id !== scene.id ||
		editor.scenes.getActiveSceneOrNull()?.tracks !== before ||
		editor.command.getStateRevision() !== revision
	) {
		throw new Error(
			"The timeline changed during Smart audio analysis. Run it again on the current clips.",
		);
	}
	if (analyzedClips === 0)
		throw new Error("No source audio was available to analyze.");
	if (ranges.length === 0) {
		const noCuts = new Error(
			holdReasons.size > 0
				? "No cuts applied: the audio did not provide enough separation between speech and background sound."
				: "No clear pauses met this duration after protecting speech and word boundaries. No cuts applied.",
		);
		noCuts.name = "NoClearSilence";
		throw noCuts;
	}
	const after = removeSilenceRangesFromTracks({
		tracks: before,
		ranges,
		cutElementIds: selected.map(({ element }) => element.id),
		captionCanvasSize: project.settings.canvasSize,
	});
	const selectedIds = new Set(selected.map(({ element }) => element.id));
	const afterTracks = [after.main, ...after.overlay, ...after.audio];
	const afterElements = new Map<string, TimelineElement>();
	for (const track of afterTracks)
		for (const element of track.elements)
			afterElements.set(element.id, element);
	for (const track of [before.main, ...before.overlay, ...before.audio]) {
		if (
			"locked" in track &&
			track.locked === true &&
			JSON.stringify(track) !==
				JSON.stringify(afterTracks.find((next) => next.id === track.id))
		) {
			throw new Error(
				"Smart audio cut would change a locked track. Unlock it before applying the edit.",
			);
		}
		if ("muted" in track && track.muted) continue;
		for (const element of track.elements) {
			if (
				selectedIds.has(element.id) ||
				(element.type !== "audio" && element.type !== "video") ||
				isElementMuted({ element }) ||
				!doesElementHaveEnabledAudio({
					element,
					mediaAsset:
						"mediaId" in element ? mediaById.get(element.mediaId) : undefined,
				})
			)
				continue;
			const next = afterElements.get(element.id);
			if (!next || (next.type !== "audio" && next.type !== "video"))
				throw new Error(
					"Smart audio cut would remove another audible clip. No cuts applied.",
				);
			const originalTiming = getClipAudioTiming(element);
			const nextTiming = getClipAudioTiming(next);
			const sourceEnd =
				originalTiming.trimStart +
				originalTiming.duration * (element.retime?.rate ?? 1);
			const nextSourceEnd =
				nextTiming.trimStart + nextTiming.duration * (next.retime?.rate ?? 1);
			if (
				nextTiming.trimStart > originalTiming.trimStart + 1e-9 ||
				nextSourceEnd < sourceEnd - 1e-9 ||
				next.trimEnd > element.trimEnd
			)
				throw new Error(
					"Smart audio cut would shorten another audible clip. No cuts applied.",
				);
		}
	}
	signal?.throwIfAborted();
	editor.command.executeSilenceTransaction({
		operation: "smart-remove",
		execute: () => {
			editor.command.execute({
				command: new TracksSnapshotCommand({ before, after }),
				applyRipple: false,
			});
		},
	});
}
