import {
	findCaptionSourceTrack,
	rebuildCaptionTracksWithSource,
} from "@/subtitles/caption-tracks";
import type { TranscriptionWord } from "@/transcription/types";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import type { TakePhrase } from "./segment-phrases";

export interface ReorganizeTakesPlan {
	/** Corrected chronological sequence of all kept phrase ids. */
	order: string[];
	/** Phrase ids to drop entirely (redundant fragments, false starts). */
	cut: string[];
	/** Groups of near-duplicate phrase ids — surfaced to the editor as linked bookmarks. */
	takeClusters: Array<{ ids: string[]; label?: string }>;
}

export interface ApplyReorganizeTakesResult {
	tracks: SceneTracks;
	/** New absolute start time for each kept phrase id, used to place take-cluster bookmarks. */
	phraseStartTimes: Map<string, MediaTime>;
}

/**
 * Splits the given video element at phrase boundaries, drops cut phrases, and reassembles the
 * rest back-to-back in the plan's corrected order — then rebuilds captions to match. Any phrase
 * the plan didn't explicitly place or cut is appended in its original position, so a malformed
 * plan can never silently drop footage.
 */
export function applyReorganizeTakes({
	tracks,
	element,
	scopedWords,
	phrases,
	plan,
	canvasSize,
}: {
	tracks: SceneTracks;
	element: VideoElement;
	/** The exact word list `phrases` was segmented from — required to keep index alignment. */
	scopedWords: TranscriptionWord[];
	phrases: TakePhrase[];
	plan: ReorganizeTakesPlan;
	canvasSize: { width: number; height: number };
}): ApplyReorganizeTakesResult | null {
	const phraseById = new Map(phrases.map((phrase) => [phrase.id, phrase]));
	const cutIds = new Set(plan.cut.filter((id) => phraseById.has(id)));
	const placedIds = new Set(plan.order.filter((id) => phraseById.has(id)));
	const strandedIds = phrases
		.map((phrase) => phrase.id)
		.filter((id) => !cutIds.has(id) && !placedIds.has(id));
	const resolvedOrder = [
		...plan.order.filter((id) => placedIds.has(id)),
		...strandedIds,
	];

	const subElementsByPhraseId = buildPhraseSubElements({
		element,
		phrases,
		keepIds: new Set([...placedIds, ...strandedIds]),
	});
	if (subElementsByPhraseId.size === 0) return null;

	let cursor = element.startTime;
	const phraseStartTimes = new Map<string, MediaTime>();
	const placedElements: VideoElement[] = [];
	for (const id of resolvedOrder) {
		const subElement = subElementsByPhraseId.get(id);
		if (!subElement) continue;
		const positioned: VideoElement = { ...subElement, startTime: cursor };
		placedElements.push(positioned);
		phraseStartTimes.set(id, cursor);
		cursor = addMediaTime({ a: cursor, b: positioned.duration });
	}
	if (placedElements.length === 0) return null;

	const tracksWithPlacedElements = replaceElementInTracks({
		tracks,
		elementId: element.id,
		replacements: placedElements,
	});

	const updatedWords = buildUpdatedWords({
		scopedWords,
		phrases,
		order: resolvedOrder,
		phraseStartTimes,
	});
	const captionsResult = rebuildCaptions({
		tracks: tracksWithPlacedElements,
		scopedWords,
		updatedWords,
		canvasSize,
	});

	return {
		tracks: captionsResult ?? tracksWithPlacedElements,
		phraseStartTimes,
	};
}

function buildPhraseSubElements({
	element,
	phrases,
	keepIds,
}: {
	element: VideoElement;
	phrases: TakePhrase[];
	keepIds: Set<string>;
}): Map<string, VideoElement> {
	const elementStart = element.startTime;
	const elementEnd = addMediaTime({ a: element.startTime, b: element.duration });
	const result = new Map<string, VideoElement>();
	for (const phrase of phrases) {
		if (!keepIds.has(phrase.id)) continue;
		const phraseStart = mediaTimeFromSeconds({ seconds: phrase.startTime });
		const phraseEnd = mediaTimeFromSeconds({ seconds: phrase.endTime });
		const clampedStart = Math.max(phraseStart, elementStart);
		const clampedEnd = Math.min(phraseEnd, elementEnd);
		const offset = clampedStart - elementStart;
		const subDuration = Math.max(0, clampedEnd - clampedStart);
		if (subDuration <= 0) continue;
		const tailTrim = element.duration - offset - subDuration;
		result.set(phrase.id, {
			...element,
			id: generateUUID(),
			startTime: mediaTime({ ticks: clampedStart }),
			duration: mediaTime({ ticks: subDuration }),
			trimStart: mediaTime({ ticks: element.trimStart + offset }),
			trimEnd: mediaTime({ ticks: element.trimEnd + tailTrim }),
		});
	}
	return result;
}

function replaceElementInTracks({
	tracks,
	elementId,
	replacements,
}: {
	tracks: SceneTracks;
	elementId: string;
	replacements: VideoElement[];
}): SceneTracks {
	const updateVideoTrack = (track: VideoTrack): VideoTrack => {
		if (!track.elements.some((candidate) => candidate.id === elementId)) {
			return track;
		}
		return {
			...track,
			elements: track.elements.flatMap((candidate) =>
				candidate.id === elementId ? replacements : [candidate],
			),
		};
	};
	return {
		...tracks,
		main: updateVideoTrack(tracks.main),
		overlay: tracks.overlay.map((track) =>
			track.type === "video" ? updateVideoTrack(track) : track,
		),
	};
}

function buildUpdatedWords({
	scopedWords,
	phrases,
	order,
	phraseStartTimes,
}: {
	scopedWords: TranscriptionWord[];
	phrases: TakePhrase[];
	order: string[];
	phraseStartTimes: Map<string, MediaTime>;
}): TranscriptionWord[] {
	const phraseById = new Map(phrases.map((phrase) => [phrase.id, phrase]));
	const updated: TranscriptionWord[] = [];
	for (const id of order) {
		const phrase = phraseById.get(id);
		const newStartTicks = phraseStartTimes.get(id);
		if (!phrase || newStartTicks === undefined) continue;
		const newStartSeconds = mediaTimeToSeconds({ time: newStartTicks });
		const [start, end] = phrase.wordIndexRange;
		for (const word of scopedWords.slice(start, end)) {
			updated.push({
				...word,
				start: newStartSeconds + (word.start - phrase.startTime),
				end: newStartSeconds + (word.end - phrase.startTime),
			});
		}
	}
	return updated;
}

function rebuildCaptions({
	tracks,
	scopedWords,
	updatedWords,
	canvasSize,
}: {
	tracks: SceneTracks;
	scopedWords: TranscriptionWord[];
	updatedWords: TranscriptionWord[];
	canvasSize: { width: number; height: number };
}): SceneTracks | null {
	const source = findCaptionSourceTrack({ tracks })?.captionSource;
	if (!source) return null;
	const scopedWordSet = new Set(scopedWords);
	const outOfScopeWords = source.words.filter(
		(word) => !scopedWordSet.has(word),
	);
	const allWords = [...outOfScopeWords, ...updatedWords].sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
	return rebuildCaptionTracksWithSource({
		tracks,
		words: allWords,
		settings: source.settings,
		canvasSize,
		layerCount: source.layerCount,
		preserveEditedElements: false,
	});
}
