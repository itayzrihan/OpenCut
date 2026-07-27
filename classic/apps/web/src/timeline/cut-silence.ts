import type { CaptionWord } from "opencut-wasm";
import {
	hasSameCaptionSource,
	rebuildCaptionTracksWithSource,
} from "@/subtitles/caption-tracks";
import type { TranscriptionWord } from "@/transcription/types";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	OverlayTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "./types";
import { removeTimeRangeFromTracks } from "./remove-time-range";
import { applyElementUpdate } from "./update-pipeline";
import { cutSilenceWasm } from "./cut-silence-wasm";

export interface TimelineTimeRange {
	startTime: MediaTime;
	endTime: MediaTime;
}

/**
 * Splices silence only from the selected video clips. Every companion layer is
 * kept intact, rippled across the removed ranges by Rust, and tail-trimmed only
 * when it would exceed the resulting visual timeline.
 */
export function removeSilenceRangesFromTracks({
	tracks,
	ranges,
	cutElementIds,
	captionCanvasSize,
	captionWordsOverride,
	captionWordsOverrideSourceId,
}: {
	tracks: SceneTracks;
	ranges: TimelineTimeRange[];
	cutElementIds: string[];
	/** Enables one canonical caption regeneration after all cuts are finalized. */
	captionCanvasSize?: { width: number; height: number };
	/** Deep audio analysis may refine these timings before the ripple is applied. */
	captionWordsOverride?: TranscriptionWord[];
	/** Required to target an override when independent caption sources coexist. */
	captionWordsOverrideSourceId?: string;
}): SceneTracks {
	const orderedRanges = cutSilenceWasm
		.normalizeTimelineTimeRanges({ ranges })
		.map(({ startTime, endTime }) => ({
			startTime: mediaTime({ ticks: startTime }),
			endTime: mediaTime({ ticks: endTime }),
		}));
	const hasCaptionSource = tracks.overlay.some(
		(track) => track.type === "text" && track.captionSource,
	);
	const canApplyCaptionOverride =
		captionCanvasSize !== undefined &&
		captionWordsOverride !== undefined &&
		hasCaptionSource;
	if (orderedRanges.length === 0 && !canApplyCaptionOverride) return tracks;
	if (orderedRanges.length > 0 && cutElementIds.length === 0) return tracks;

	const originalCutElementIds = new Set(cutElementIds);
	const currentCutElementIds = new Set(cutElementIds);
	let cutTracks = tracks;
	for (const range of orderedRanges) {
		cutTracks = removeTimeRangeFromTracks({
			tracks: cutTracks,
			...range,
			targetElementIds: currentCutElementIds,
		});
	}

	const preservedElements = getTracksInStorageOrder({ tracks }).flatMap(
		(track) =>
			(track.elements as TimelineElement[]).flatMap((element) =>
				originalCutElementIds.has(element.id)
					? []
					: [
							{
								element,
								collisionGroup: track.type === "text" ? track.id : undefined,
							},
						],
			),
	);
	const shouldRegenerateCaptions =
		captionCanvasSize !== undefined && hasCaptionSource;
	const captionWords = shouldRegenerateCaptions
		? []
		: tracks.overlay.flatMap((track) => {
				if (track.type !== "text" || !track.captionSource) return [];
				return track.captionSource.words.map((word, wordIndex) => ({
					trackId: track.id,
					wordIndex,
					word,
				}));
			});
	const durationElements = [
		...tracks.overlay.flatMap((track) => track.elements as TimelineElement[]),
		...tracks.main.elements,
	];
	const timingPlan = cutSilenceWasm.preserveClipsDuringTimeRemoval({
		clips: [
			...preservedElements.map(({ element, collisionGroup }) => ({
				startTime: element.startTime,
				duration: element.duration,
				trimEnd: element.trimEnd,
				collisionGroup,
				sourceRate:
					element.type === "audio" || element.type === "video"
						? (element.retime?.rate ?? 1)
						: undefined,
			})),
			...captionWords.map(({ word }) => ({
				startTime: mediaTimeFromSeconds({ seconds: word.start }),
				duration: mediaTimeFromSeconds({
					seconds: Math.max(0, word.end - word.start),
				}),
				trimEnd: mediaTime({ ticks: 0 }),
			})),
		],
		removedRanges: orderedRanges,
		durationClips: durationElements.map((element) => ({
			startTime: element.startTime,
			duration: element.duration,
		})),
	});

	const elementTimings = new Map(
		preservedElements.map(({ element }, index) => [
			element.id,
			timingPlan.clips[index],
		]),
	);
	const captionTimingOffset = preservedElements.length;
	const captionTimings = new Map(
		captionWords.map(({ trackId, wordIndex }, index) => [
			`${trackId}:${wordIndex}`,
			timingPlan.clips[captionTimingOffset + index],
		]),
	);

	function updateTrack(track: VideoTrack): VideoTrack;
	function updateTrack(track: TextTrack): TextTrack;
	function updateTrack(track: AudioTrack): AudioTrack;
	function updateTrack(track: GraphicTrack): GraphicTrack;
	function updateTrack(track: EffectTrack): EffectTrack;
	function updateTrack(track: OverlayTrack): OverlayTrack;
	function updateTrack(track: TimelineTrack): TimelineTrack {
		const elements = track.elements.flatMap((element) => {
			if (currentCutElementIds.has(element.id)) return [element];
			const timing = elementTimings.get(element.id);
			if (!timing) return [element];
			if (timing.duration <= 0) return [];
			return [
				applyElementUpdate({
					element,
					patch: {
						startTime: mediaTime({ ticks: timing.startTime }),
						duration: mediaTime({ ticks: timing.duration }),
						trimEnd: mediaTime({ ticks: timing.trimEnd }),
					},
					context: { tracks: cutTracks, trackId: track.id },
				}),
			];
		});
		switch (track.type) {
			case "video":
				return { ...track, elements: elements.filter(isVideoTrackElement) };
			case "text":
				return { ...track, elements: elements.filter(isTextTrackElement) };
			case "audio":
				return { ...track, elements: elements.filter(isAudioTrackElement) };
			case "graphic":
				return { ...track, elements: elements.filter(isGraphicTrackElement) };
			case "effect":
				return { ...track, elements: elements.filter(isEffectTrackElement) };
		}
	}
	const updatedTracks: SceneTracks = {
		...cutTracks,
		overlay: cutTracks.overlay.map((track) => updateTrack(track)),
		main: updateTrack(cutTracks.main),
		audio: cutTracks.audio.map((track) => updateTrack(track)),
	};

	const withUpdatedCaptionWords = {
		...updatedTracks,
		overlay: updatedTracks.overlay.map((track) => {
			if (track.type !== "text" || !track.captionSource) return track;
			return {
				...track,
				captionSource: {
					...track.captionSource,
					words: track.captionSource.words.flatMap((word, wordIndex) => {
						const timing = captionTimings.get(`${track.id}:${wordIndex}`);
						if (!timing) return [word];
						if (timing.duration <= 0) return [];
						return [
							{
								...word,
								start: mediaTimeToSeconds({
									time: mediaTime({ ticks: timing.startTime }),
								}),
								end: mediaTimeToSeconds({
									time: addMediaTime({
										a: mediaTime({ ticks: timing.startTime }),
										b: mediaTime({ ticks: timing.duration }),
									}),
								}),
							},
						];
					}),
				},
			};
		}),
	};

	if (!shouldRegenerateCaptions || !captionCanvasSize) {
		return withUpdatedCaptionWords;
	}

	const captionRanges = orderedRanges.map(({ startTime, endTime }) => ({
		start: mediaTimeToSeconds({ time: startTime }),
		end: mediaTimeToSeconds({ time: endTime }),
	}));
	const sourceGroups = collectCaptionSourceGroups({
		tracks: withUpdatedCaptionWords,
	});
	let regeneratedTracks = withUpdatedCaptionWords;
	for (const group of sourceGroups) {
		const currentGroupTracks = regeneratedTracks.overlay.filter(
			(track): track is TextTrack =>
				track.type === "text" &&
				!!track.captionSource &&
				hasSameCaptionSource({ track, source: group.source }),
		);
		const source = currentGroupTracks[0]?.captionSource;
		if (!source) continue;

		const useOverride =
			captionWordsOverride !== undefined &&
			(sourceGroups.length === 1 ||
				(captionWordsOverrideSourceId !== undefined &&
					source.sourceId === captionWordsOverrideSourceId));
		const transformedWords = transformCaptionWordsForRemoval({
			words: useOverride ? captionWordsOverride : source.words,
			ranges: captionRanges,
		});
		const currentGroupTrackIds = new Set(
			currentGroupTracks.map((track) => track.id),
		);
		const tracksWithCurrentGroupFirst = {
			...regeneratedTracks,
			overlay: [
				...currentGroupTracks,
				...regeneratedTracks.overlay.filter(
					(track) => !currentGroupTrackIds.has(track.id),
				),
			],
		};
		regeneratedTracks =
			rebuildCaptionTracksWithSource({
				tracks: tracksWithCurrentGroupFirst,
				words: transformedWords,
				settings: source.settings,
				canvasSize: captionCanvasSize,
				layerCount: source.layerCount,
				preserveEditedElements: false,
			}) ?? regeneratedTracks;
	}

	return regeneratedTracks;
}

function transformCaptionWordsForRemoval({
	words,
	ranges,
}: {
	words: TranscriptionWord[];
	ranges: Array<{ start: number; end: number }>;
}): TranscriptionWord[] {
	const generatedWords = words.filter(
		(word) => word.source?.type !== "text-layer",
	);
	const ownedWords = words.filter((word) => word.source?.type === "text-layer");
	return sortCaptionWords([
		...transcriptionWordsFromWasm({
			words: cutSilenceWasm.realignCaptionWordsAfterTimeRemoval({
				words: generatedWords,
				ranges,
			}),
		}),
		...transcriptionWordsFromWasm({
			words: cutSilenceWasm.removeCaptionWordTimeRanges({
				words: ownedWords,
				ranges,
			}),
		}),
	]);
}

function collectCaptionSourceGroups({
	tracks,
}: {
	tracks: SceneTracks;
}): Array<{ source: NonNullable<TextTrack["captionSource"]> }> {
	const captionTracks = tracks.overlay.filter(
		(track): track is TextTrack =>
			track.type === "text" && !!track.captionSource,
	);
	const assignedTrackIds = new Set<string>();
	const groups: Array<{ source: NonNullable<TextTrack["captionSource"]> }> = [];
	for (const track of captionTracks) {
		if (assignedTrackIds.has(track.id) || !track.captionSource) continue;
		const source = track.captionSource;
		for (const candidate of captionTracks) {
			if (hasSameCaptionSource({ track: candidate, source })) {
				assignedTrackIds.add(candidate.id);
			}
		}
		groups.push({ source });
	}
	return groups;
}

function transcriptionWordsFromWasm({
	words,
}: {
	words: CaptionWord[];
}): TranscriptionWord[] {
	return words.map((word) => ({
		text: word.text,
		start: word.start,
		end: word.end,
		source:
			word.source?.type === "text-layer"
				? {
						type: "text-layer",
						trackId: word.source.trackId,
						elementId: word.source.elementId,
						wordIndex: word.source.wordIndex,
						wordId: word.source.wordId,
					}
				: undefined,
	}));
}

function sortCaptionWords(words: TranscriptionWord[]): TranscriptionWord[] {
	return words.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
}

function getTracksInStorageOrder({
	tracks,
}: {
	tracks: SceneTracks;
}): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function isVideoTrackElement(
	element: TimelineElement,
): element is VideoTrack["elements"][number] {
	return element.type === "video" || element.type === "image";
}

function isTextTrackElement(
	element: TimelineElement,
): element is TextTrack["elements"][number] {
	return element.type === "text";
}

function isAudioTrackElement(
	element: TimelineElement,
): element is AudioTrack["elements"][number] {
	return element.type === "audio";
}

function isGraphicTrackElement(
	element: TimelineElement,
): element is GraphicTrack["elements"][number] {
	return element.type === "graphic" || element.type === "sticker";
}

function isEffectTrackElement(
	element: TimelineElement,
): element is EffectTrack["elements"][number] {
	return element.type === "effect";
}
