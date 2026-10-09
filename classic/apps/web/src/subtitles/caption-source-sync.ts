import { stripCaptionPunctuation } from "@/subtitles/caption-layout";
import {
	findCaptionSourceTrack,
	findCaptionSourceTracks,
	rebuildCaptionTracksWithSource,
} from "@/subtitles/caption-tracks";
import type { SceneTracks, TextElement, TextTrack } from "@/timeline";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTimeToSeconds } from "@/wasm";
import {
	normalizeTextLayerWordIds,
	reconcileCaptionWords,
	planCaptionSceneTranscriptSync,
	planCaptionManualWordReplacement,
} from "opencut-wasm";

interface UpdatedElementRef {
	trackId: string;
	elementId: string;
}

interface TranscriptWordSnapshot {
	wordId?: string;
	text: string;
	start: number;
	end: number;
}

interface PresentationWordSnapshot {
	wordId?: string;
	text: string;
}

export function syncCaptionSourceWordsFromElements({
	tracks,
	previousTracks,
	updates,
	canvasSize,
}: {
	tracks: SceneTracks;
	previousTracks?: SceneTracks;
	updates: UpdatedElementRef[];
	canvasSize?: { width: number; height: number };
}): SceneTracks {
	// Rust owns source membership, ordered element matching and transcript edits.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The shared Rust planner returns source indices and field edits.
	const plan = JSON.parse(
		planCaptionSceneTranscriptSync({
			inputJson: JSON.stringify({ tracks, previousTracks, updates }),
		}),
	) as TranscriptSyncPlan & {
		firstIndex: number | null;
		sourceIndices: number[];
	};
	if (!plan.changed || plan.firstIndex === null) return tracks;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Rust only selects text tracks carrying captionSource.
	const source = (tracks.overlay[plan.firstIndex] as TextTrack).captionSource!;
	const nextWords = plan.words.map(({ sourceIndex, text, start, end }) => {
		const original = source.words[sourceIndex];
		return original.text === text &&
			original.start === start &&
			original.end === end
			? original
			: { ...original, text, start, end };
	});
	if (canvasSize) {
		const rebuiltTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: nextWords,
			settings: source.settings,
			canvasSize,
			layerCount: source.layerCount,
			ignoredEditedElements: updates,
			preserveEditedElements: false,
		});
		if (rebuiltTracks) return rebuiltTracks;
	}
	const indices = new Set(plan.sourceIndices);
	return {
		...tracks,
		overlay: tracks.overlay.map((track, index) => {
			if (!indices.has(index) || track.type !== "text" || !track.captionSource)
				return track;
			return {
				...track,
				captionSource: { ...track.captionSource, words: nextWords },
			};
		}),
	};
}

export function syncTextLayerWordsIntoCaptionSource({
	tracks,
	previousTracks,
	elements,
}: {
	tracks: SceneTracks;
	previousTracks?: SceneTracks;
	elements: UpdatedElementRef[];
}): SceneTracks {
	const sourceTrack = findCaptionSourceTrack({ tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return tracks;

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Rust supplies the generated source indices replaced by moved manual layers.
	const replacement = JSON.parse(
		planCaptionManualWordReplacement({
			inputJson: JSON.stringify({ tracks, previousTracks, elements }),
		}),
	) as { indices: number[] };
	const generatedWordIndexesToReplace = new Set(replacement.indices);
	let nextTracks = tracks;
	if (generatedWordIndexesToReplace.size > 0) {
		nextTracks = updateCaptionSourceWordsInTracks({
			tracks,
			source,
			words: source.words.filter(
				(_, index) => !generatedWordIndexesToReplace.has(index),
			),
		});
	}

	return reconcileTextLayerWordsInCaptionSource({ tracks: nextTracks });
}

/**
 * Enforces the words-track ownership invariant from the layers that currently
 * exist. Rust owns the reconciliation policy; this function only flattens the
 * web timeline model into the shared input shape and writes the result back.
 */
export function reconcileTextLayerWordsInCaptionSource({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	const sourceTrack = findCaptionSourceTrack({ tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return tracks;

	const textLayers = tracks.overlay.flatMap((track) => {
		if (track.type !== "text" || track.captionSource) return [];
		return track.elements.map((element) => ({
			trackId: track.id,
			elementId: element.id,
			startTime: element.startTime,
			duration: element.duration,
			content:
				typeof element.params.content === "string"
					? element.params.content
					: "",
			wordRuns: (element.wordRuns ?? []).map((run) => ({
				id: run.id,
				text: run.text,
				lineIndex: run.lineIndex,
				startTime: run.startTime,
				endTime: run.endTime,
			})),
		}));
	});
	const words = reconcileCaptionWords({
		words: source.words,
		textLayers,
	}) as TranscriptionWord[];
	if (areTranscriptionWordsEqual({ left: source.words, right: words })) {
		return tracks;
	}

	return updateCaptionSourceWordsInTracks({ tracks, source, words });
}

/** Repairs duplicate word-run IDs inside each text layer before any word-track
 * ownership or editing lookup is derived from them. */
export function normalizeTextLayerWordRunIds({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	let didChange = false;
	const overlay = tracks.overlay.map((track) => {
		if (track.type !== "text") return track;
		let didChangeTrack = false;
		const elements = track.elements.map((element) => {
			if (!element.wordRuns?.length) return element;
			const normalized = normalizeTextLayerWordIds({
				wordRuns: element.wordRuns,
			});
			if (
				normalized.every(
					(word) => element.wordRuns?.[word.previousWordIndex]?.id === word.id,
				)
			) {
				return element;
			}
			didChange = true;
			didChangeTrack = true;
			return {
				...element,
				wordRuns: element.wordRuns.map((run, index) => ({
					...run,
					id: normalized[index]?.id ?? run.id,
				})),
			};
		});
		return didChangeTrack ? { ...track, elements } : track;
	});

	return didChange ? { ...tracks, overlay } : tracks;
}

export function removeTextLayerWordsFromCaptionSource({
	tracks,
	elements,
}: {
	tracks: SceneTracks;
	elements: UpdatedElementRef[];
}): SceneTracks {
	const sourceTrack = findCaptionSourceTrack({ tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return tracks;

	const removedKeys = new Set(
		elements.map(({ trackId, elementId }) => `${trackId}:${elementId}`),
	);
	const nextWords = source.words.filter((word) => {
		if (word.source?.type !== "text-layer") return true;
		return !removedKeys.has(`${word.source.trackId}:${word.source.elementId}`);
	});
	const withoutRemoved = areTranscriptionWordsEqual({
		left: source.words,
		right: nextWords,
	})
		? tracks
		: updateCaptionSourceWordsInTracks({ tracks, source, words: nextWords });

	return reconcileTextLayerWordsInCaptionSource({ tracks: withoutRemoved });
}

/**
 * Removes generated transcript words whose caption elements were explicitly
 * deleted. Generated words intentionally survive the manual-layer reconciler,
 * so destructive caption commands must identify them from the pre-edit layer.
 */
export function removeCaptionElementWordsFromSource({
	tracks,
	previousTracks,
	elements,
}: {
	tracks: SceneTracks;
	previousTracks: SceneTracks;
	elements: UpdatedElementRef[];
}): SceneTracks {
	const sourceTrack = findCaptionSourceTrack({ tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return tracks;

	const previousSourceTracks = findCaptionSourceTracks({
		tracks: previousTracks,
		source,
	});
	const usedIndexes = new Set<number>();
	const indexesToRemove = new Set<number>();

	for (const ref of dedupeElementRefs({ elements })) {
		const previousTrack = previousSourceTracks.find(
			(track) => track.id === ref.trackId,
		);
		const previousElement = previousTrack?.elements.find(
			(element) => element.id === ref.elementId,
		);
		if (!previousElement) continue;

		const transcriptEntries = getElementTranscriptWordSnapshots({
			element: previousElement,
		});
		for (const entry of transcriptEntries) {
			const sourceIndex = findSourceWordIndexForTranscriptEntry({
				sourceWords: source.words,
				entry,
				usedIndexes,
			});
			if (sourceIndex < 0) continue;
			usedIndexes.add(sourceIndex);
			indexesToRemove.add(sourceIndex);
		}

		if (transcriptEntries.length === 0) {
			for (const sourceIndex of mapPresentationEntriesToSourceWords({
				sourceWords: source.words,
				entries: getElementPresentationWordSnapshots({
					element: previousElement,
				}),
				element: previousElement,
			}).values()) {
				if (usedIndexes.has(sourceIndex)) continue;
				usedIndexes.add(sourceIndex);
				indexesToRemove.add(sourceIndex);
			}
		}
	}

	if (indexesToRemove.size === 0) return tracks;
	return updateCaptionSourceWordsInTracks({
		tracks,
		source,
		words: source.words.filter((_, index) => !indexesToRemove.has(index)),
	});
}

interface TranscriptSyncPlan {
	changed: boolean;
	words: { sourceIndex: number; text: string; start: number; end: number }[];
}

function findSourceWordIndexForTranscriptEntry({
	sourceWords,
	entry,
	usedIndexes,
}: {
	sourceWords: TranscriptionWord[];
	entry: TranscriptWordSnapshot;
	usedIndexes: Set<number>;
}): number {
	const normalizedEntry = normalizeTranscriptText({ text: entry.text });
	let bestIndex = -1;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const [index, word] of sourceWords.entries()) {
		if (usedIndexes.has(index)) continue;
		if (word.source?.type === "text-layer") continue;
		if (normalizeTranscriptText({ text: word.text }) !== normalizedEntry) {
			continue;
		}
		const score =
			Math.abs(word.start - entry.start) + Math.abs(word.end - entry.end);
		if (score < bestScore) {
			bestIndex = index;
			bestScore = score;
		}
	}

	return bestIndex;
}

function mapPresentationEntriesToSourceWords({
	sourceWords,
	entries,
	element,
}: {
	sourceWords: TranscriptionWord[];
	entries: PresentationWordSnapshot[];
	element: TextElement;
}): Map<number, number> {
	const usedSourceIndexes = new Set<number>();
	const result = new Map<number, number>();
	let searchStart = 0;

	entries.forEach((entry, entryIndex) => {
		let sourceIndex = findSourceWordIndexForPresentationEntry({
			sourceWords,
			entry,
			element,
			usedIndexes: usedSourceIndexes,
			searchStart,
		});
		if (sourceIndex < 0) {
			sourceIndex = findSourceWordIndexForPresentationEntry({
				sourceWords,
				entry,
				element,
				usedIndexes: usedSourceIndexes,
				searchStart: 0,
			});
		}
		if (sourceIndex < 0) return;
		usedSourceIndexes.add(sourceIndex);
		result.set(entryIndex, sourceIndex);
		searchStart = sourceIndex + 1;
	});

	return result;
}

function findSourceWordIndexForPresentationEntry({
	sourceWords,
	entry,
	element,
	usedIndexes,
	searchStart,
}: {
	sourceWords: TranscriptionWord[];
	entry: PresentationWordSnapshot;
	element: TextElement;
	usedIndexes: Set<number>;
	searchStart: number;
}): number {
	const normalizedEntry = normalizeTranscriptText({ text: entry.text });
	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const elementEnd =
		elementStart + mediaTimeToSeconds({ time: element.duration });
	let fallbackIndex = -1;

	for (let index = searchStart; index < sourceWords.length; index++) {
		const word = sourceWords[index];
		if (!word || usedIndexes.has(index)) continue;
		if (word.source?.type === "text-layer") continue;
		if (normalizeTranscriptText({ text: word.text }) !== normalizedEntry) {
			continue;
		}
		fallbackIndex = fallbackIndex < 0 ? index : fallbackIndex;
		const midpoint = (word.start + word.end) / 2;
		if (midpoint >= elementStart - 0.001 && midpoint <= elementEnd + 0.001) {
			return index;
		}
	}

	return fallbackIndex;
}

function normalizeTranscriptText({ text }: { text: string }) {
	return stripCaptionPunctuation({ text }).toLocaleLowerCase();
}

function getContentWords({ element }: { element: TextElement }) {
	const content =
		typeof element.params.content === "string" ? element.params.content : "";
	return content.trim().split(/\s+/).filter(Boolean);
}

function updateCaptionSourceWordsInTracks({
	tracks,
	source,
	words,
}: {
	tracks: SceneTracks;
	source: NonNullable<TextTrack["captionSource"]>;
	words: TranscriptionWord[];
}): SceneTracks {
	const sourceTracks = findCaptionSourceTracks({ tracks, source });
	const sourceTrackIds = new Set(sourceTracks.map((track) => track.id));
	return {
		...tracks,
		overlay: tracks.overlay.map((track) => {
			if (track.type !== "text" || !sourceTrackIds.has(track.id)) return track;
			return {
				...track,
				captionSource: track.captionSource
					? {
							...track.captionSource,
							words,
						}
					: undefined,
			};
		}),
	};
}

function areTranscriptionWordsEqual({
	left,
	right,
}: {
	left: TranscriptionWord[];
	right: TranscriptionWord[];
}) {
	if (left.length !== right.length) return false;
	return left.every((word, index) => {
		const candidate = right[index];
		return (
			candidate?.text === word.text &&
			candidate.start === word.start &&
			candidate.end === word.end &&
			candidate.source?.type === word.source?.type &&
			candidate.source?.trackId === word.source?.trackId &&
			candidate.source?.elementId === word.source?.elementId &&
			candidate.source?.wordIndex === word.source?.wordIndex &&
			candidate.source?.wordId === word.source?.wordId
		);
	});
}

function dedupeElementRefs({
	elements,
}: {
	elements: UpdatedElementRef[];
}): UpdatedElementRef[] {
	const seen = new Set<string>();
	return elements.filter(({ trackId, elementId }) => {
		const key = `${trackId}:${elementId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function getElementTranscriptWordSnapshots({
	element,
}: {
	element: TextElement;
}): TranscriptWordSnapshot[] {
	if (element.wordRuns?.length) {
		const elementStart = mediaTimeToSeconds({ time: element.startTime });
		return element.wordRuns.flatMap((run) => {
			if (!isTimedWordRun(run)) return [];
			const start = elementStart + mediaTimeToSeconds({ time: run.startTime });
			const end = elementStart + mediaTimeToSeconds({ time: run.endTime });
			return {
				wordId: run.id,
				text: run.text,
				start: roundSeconds(start),
				end: roundSeconds(Math.max(start + 0.01, end)),
			};
		});
	}

	const contentWords = getContentWords({ element });
	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const duration = mediaTimeToSeconds({ time: element.duration });
	const wordDuration =
		contentWords.length > 0 ? duration / contentWords.length : 0;
	return contentWords.map((text, index) => {
		const start = elementStart + index * wordDuration;
		const end = elementStart + (index + 1) * wordDuration;
		return {
			wordId: `word-${index}`,
			text,
			start: roundSeconds(start),
			end: roundSeconds(Math.max(start + 0.01, end)),
		};
	});
}

function getElementPresentationWordSnapshots({
	element,
}: {
	element: TextElement;
}): PresentationWordSnapshot[] {
	return (element.wordRuns ?? []).flatMap((run) => {
		if (!run.text.trim()) return [];
		return [
			{
				wordId: run.id,
				text: run.text,
			},
		];
	});
}

function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}

function isTimedWordRun(
	run: NonNullable<TextElement["wordRuns"]>[number],
): run is NonNullable<TextElement["wordRuns"]>[number] &
	Required<
		Pick<NonNullable<TextElement["wordRuns"]>[number], "startTime" | "endTime">
	> {
	return run.startTime != null && run.endTime != null;
}
