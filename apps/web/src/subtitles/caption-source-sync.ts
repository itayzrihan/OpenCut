import {
	buildSubtitleCuesFromWords,
	splitCaptionCuesByLayer,
	stripCaptionPunctuation,
} from "@/subtitles/caption-layout";
import {
	findCaptionSourceTrack,
	findCaptionSourceTracks,
	getGeneratedCaptionWords,
	hasSameCaptionSource,
	rebuildCaptionTracksWithSource,
} from "@/subtitles/caption-tracks";
import type {
	OverlayTrack,
	SceneTracks,
	TextElement,
	TextTrack,
} from "@/timeline";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTimeToSeconds } from "@/wasm";
import { normalizeTextLayerWordIds, reconcileCaptionWords } from "opencut-wasm";

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
	const sourceTrack = findCaptionSourceTrack({ tracks });
	const source = sourceTrack?.captionSource;
	if (!source) return tracks;

	let nextWords = source.words;
	let didChange = false;
	const sourceTracks = findCaptionSourceTracks({ tracks, source });

	for (const update of updates) {
		const track = sourceTracks.find(
			(candidate) => candidate.id === update.trackId,
		);
		const elementIndex =
			track?.elements.findIndex((element) => element.id === update.elementId) ??
			-1;
		const element =
			elementIndex >= 0 ? track?.elements[elementIndex] : undefined;
		if (!track || !element) continue;
		if (
			previousTracks &&
			!hasElementTranscriptSemanticChange({
				previousTracks,
				nextElement: element,
				update,
			})
		) {
			continue;
		}

		const updatedWords = syncElementWords({
			sourceWords: nextWords,
			track,
			element,
			elementIndex,
			previousElement: previousTracks
				? findTextElementInTracks({
						tracks: previousTracks,
						trackId: update.trackId,
						elementId: update.elementId,
					})
				: null,
		});
		if (updatedWords !== nextWords) {
			nextWords = updatedWords;
			didChange = true;
		}
	}

	if (!didChange) return tracks;

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
		if (rebuiltTracks) {
			return rebuiltTracks;
		}
	}

	const withUpdatedSource = (track: OverlayTrack): OverlayTrack => {
		if (track.type !== "text" || !track.captionSource) return track;
		if (!hasSameCaptionSource({ track, source })) return track;
		return {
			...track,
			captionSource: {
				...track.captionSource,
				words: nextWords,
			},
		};
	};

	return {
		...tracks,
		overlay: tracks.overlay.map(withUpdatedSource),
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

	const uniqueElements = dedupeElementRefs({ elements });
	const sourceTracks = findCaptionSourceTracks({ tracks, source });
	const sourceTrackIds = new Set(sourceTracks.map((track) => track.id));
	const generatedWordIndexesToReplace = previousTracks
		? getGeneratedWordIndexesForPreviousCaptionElements({
				source,
				sourceWords: source.words,
				previousTracks,
				currentSourceTrackIds: sourceTrackIds,
				elements: uniqueElements,
			})
		: new Set<number>();
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

function getGeneratedWordIndexesForPreviousCaptionElements({
	source,
	sourceWords,
	previousTracks,
	currentSourceTrackIds,
	elements,
}: {
	source: NonNullable<TextTrack["captionSource"]>;
	sourceWords: TranscriptionWord[];
	previousTracks: SceneTracks;
	currentSourceTrackIds: Set<string>;
	elements: UpdatedElementRef[];
}): Set<number> {
	const previousSourceTracks = findCaptionSourceTracks({
		tracks: previousTracks,
		source,
	});
	const usedIndexes = new Set<number>();
	const indexes = new Set<number>();

	for (const ref of elements) {
		if (currentSourceTrackIds.has(ref.trackId)) continue;
		const previousElement = previousSourceTracks
			.flatMap((track) => track.elements)
			.find((element) => element.id === ref.elementId);
		if (!previousElement) continue;

		for (const entry of getElementTranscriptWordSnapshots({
			element: previousElement,
		})) {
			const sourceIndex = findSourceWordIndexForTranscriptEntry({
				sourceWords,
				entry,
				usedIndexes,
			});
			if (sourceIndex < 0) continue;
			usedIndexes.add(sourceIndex);
			indexes.add(sourceIndex);
		}
	}

	return indexes;
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

function syncElementWords({
	sourceWords,
	track,
	element,
	elementIndex,
	previousElement,
}: {
	sourceWords: TranscriptionWord[];
	track: TextTrack;
	element: TextElement;
	elementIndex: number;
	previousElement: TextElement | null;
}): TranscriptionWord[] {
	const source = track.captionSource;
	if (!source) return sourceWords;
	if (previousElement) {
		// Multiline merges deliberately strip timing from their word runs while
		// keeping the generated transcript unchanged. Treat that representation
		// change as presentation-only instead of deleting the previously timed
		// source entries.
		if (
			!isPresentationOnlyWordRunElement({ element: previousElement }) &&
			isPresentationOnlyWordRunElement({ element })
		) {
			return sourceWords;
		}
		const presentationOnlyWords = syncPresentationOnlyElementWords({
			sourceWords,
			source,
			previousElement,
			nextElement: element,
		});
		if (presentationOnlyWords !== sourceWords) {
			return presentationOnlyWords;
		}

		const updatedWords = syncElementWordsByPreviousWordRuns({
			sourceWords,
			source,
			previousElement,
			nextElement: element,
		});
		if (updatedWords !== sourceWords) {
			return updatedWords;
		}
	}

	const generatedSourceWords = getGeneratedCaptionWords({ words: sourceWords });
	const captions = buildSubtitleCuesFromWords({
		words: generatedSourceWords,
		settings: source.settings,
	});
	const layers = splitCaptionCuesByLayer({
		captions,
		layerCount: source.layerCount ?? 1,
	});
	const expectedCaption = layers[source.layerIndex ?? 0]?.[elementIndex];
	if (!expectedCaption?.words?.length) return sourceWords;

	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const contentWords = getContentWords({ element });
	const nextWords = [...sourceWords];
	let didChange = false;

	expectedCaption.words.forEach((expectedWord, wordOffset) => {
		const sourceIndex = sourceWords.findIndex((word) => word === expectedWord);
		if (sourceIndex < 0) return;
		const current = nextWords[sourceIndex];
		const run = element.wordRuns?.[wordOffset];
		const renderedText =
			run?.text ?? contentWords[wordOffset] ?? expectedWord.text;
		const nextText =
			source.settings.hidePunctuation &&
			stripCaptionPunctuation({ text: current.text }) ===
				stripCaptionPunctuation({ text: renderedText })
				? current.text
				: renderedText;
		const nextStart =
			run?.startTime == null
				? expectedWord.start
				: elementStart + mediaTimeToSeconds({ time: run.startTime });
		const nextEnd =
			run?.endTime == null
				? expectedWord.end
				: elementStart + mediaTimeToSeconds({ time: run.endTime });

		const nextWord = {
			...current,
			text: nextText,
			start: roundSeconds(nextStart),
			end: roundSeconds(Math.max(nextStart + 0.01, nextEnd)),
		};
		if (
			nextWord.text !== current.text ||
			nextWord.start !== current.start ||
			nextWord.end !== current.end
		) {
			nextWords[sourceIndex] = nextWord;
			didChange = true;
		}
	});

	return didChange ? nextWords : sourceWords;
}

function syncPresentationOnlyElementWords({
	sourceWords,
	source,
	previousElement,
	nextElement,
}: {
	sourceWords: TranscriptionWord[];
	source: NonNullable<TextTrack["captionSource"]>;
	previousElement: TextElement;
	nextElement: TextElement;
}): TranscriptionWord[] {
	if (
		!isPresentationOnlyWordRunElement({ element: previousElement }) ||
		!isPresentationOnlyWordRunElement({ element: nextElement })
	) {
		return sourceWords;
	}

	const previousEntries = getElementPresentationWordSnapshots({
		element: previousElement,
	});
	const nextEntries = getElementPresentationWordSnapshots({
		element: nextElement,
	});
	if (previousEntries.length === 0) return sourceWords;

	const sourceIndexesByPreviousEntry = mapPresentationEntriesToSourceWords({
		sourceWords,
		entries: previousEntries,
		element: previousElement,
	});
	const usedPreviousEntryIndexes = new Set<number>();
	const nextWords = [...sourceWords];
	const sourceIndexesToRemove = new Set<number>();
	let didChange = false;

	nextEntries.forEach((nextEntry, entryIndex) => {
		const previousEntryIndex = findPreviousPresentationEntryIndex({
			entries: previousEntries,
			nextEntry,
			entryIndex,
			usedIndexes: usedPreviousEntryIndexes,
		});
		if (previousEntryIndex < 0) return;

		const sourceIndex = sourceIndexesByPreviousEntry.get(previousEntryIndex);
		if (sourceIndex == null) return;

		const current = nextWords[sourceIndex];
		const nextText =
			source.settings.hidePunctuation &&
			stripCaptionPunctuation({ text: current.text }) ===
				stripCaptionPunctuation({ text: nextEntry.text })
				? current.text
				: nextEntry.text;
		if (current.text !== nextText) {
			nextWords[sourceIndex] = {
				...current,
				text: nextText,
			};
			didChange = true;
		}
	});

	for (const [entryIndex, sourceIndex] of sourceIndexesByPreviousEntry) {
		if (usedPreviousEntryIndexes.has(entryIndex)) continue;
		sourceIndexesToRemove.add(sourceIndex);
		didChange = true;
	}

	if (sourceIndexesToRemove.size > 0) {
		return nextWords.filter((_, index) => !sourceIndexesToRemove.has(index));
	}

	return didChange ? nextWords : sourceWords;
}

function syncElementWordsByPreviousWordRuns({
	sourceWords,
	source,
	previousElement,
	nextElement,
}: {
	sourceWords: TranscriptionWord[];
	source: NonNullable<TextTrack["captionSource"]>;
	previousElement: TextElement;
	nextElement: TextElement;
}): TranscriptionWord[] {
	const previousEntries = getElementTranscriptWordSnapshots({
		element: previousElement,
	});
	const nextEntries = getElementTranscriptWordSnapshots({
		element: nextElement,
	});
	if (previousEntries.length === 0) {
		return sourceWords;
	}

	const previousEntryIndexes = new Set<number>();
	const usedSourceIndexes = new Set<number>();
	const nextWords = [...sourceWords];
	let didChange = false;

	nextEntries.forEach((nextEntry, entryIndex) => {
		const previousEntry = findPreviousTranscriptEntry({
			entries: previousEntries,
			nextEntry,
			entryIndex,
			usedIndexes: previousEntryIndexes,
		});
		if (!previousEntry) return;
		const sourceIndex = findSourceWordIndexForTranscriptEntry({
			sourceWords,
			entry: previousEntry,
			usedIndexes: usedSourceIndexes,
		});
		if (sourceIndex < 0) return;
		usedSourceIndexes.add(sourceIndex);

		const current = nextWords[sourceIndex];
		const nextText =
			source.settings.hidePunctuation &&
			stripCaptionPunctuation({ text: current.text }) ===
				stripCaptionPunctuation({ text: nextEntry.text })
				? current.text
				: nextEntry.text;
		const nextWord = {
			...current,
			text: nextText,
			start: roundSeconds(nextEntry.start),
			end: roundSeconds(Math.max(nextEntry.start + 0.01, nextEntry.end)),
		};
		if (
			nextWord.text !== current.text ||
			nextWord.start !== current.start ||
			nextWord.end !== current.end
		) {
			nextWords[sourceIndex] = nextWord;
			didChange = true;
		}
	});

	const sourceIndexesToRemove = new Set<number>();
	previousEntries.forEach((previousEntry, entryIndex) => {
		if (previousEntryIndexes.has(entryIndex)) return;
		const sourceIndex = findSourceWordIndexForTranscriptEntry({
			sourceWords,
			entry: previousEntry,
			usedIndexes: usedSourceIndexes,
		});
		if (sourceIndex < 0) return;
		usedSourceIndexes.add(sourceIndex);
		sourceIndexesToRemove.add(sourceIndex);
		didChange = true;
	});

	if (sourceIndexesToRemove.size > 0) {
		return nextWords.filter((_, index) => !sourceIndexesToRemove.has(index));
	}

	return didChange ? nextWords : sourceWords;
}

function findPreviousTranscriptEntry({
	entries,
	nextEntry,
	entryIndex,
	usedIndexes,
}: {
	entries: TranscriptWordSnapshot[];
	nextEntry: TranscriptWordSnapshot;
	entryIndex: number;
	usedIndexes: Set<number>;
}): TranscriptWordSnapshot | null {
	if (nextEntry.wordId) {
		const wordIdIndex = entries.findIndex(
			(entry, index) =>
				!usedIndexes.has(index) && entry.wordId === nextEntry.wordId,
		);
		if (wordIdIndex >= 0) {
			usedIndexes.add(wordIdIndex);
			return entries[wordIdIndex];
		}
	}

	if (entries[entryIndex] && !usedIndexes.has(entryIndex)) {
		usedIndexes.add(entryIndex);
		return entries[entryIndex];
	}

	return null;
}

function findPreviousPresentationEntryIndex({
	entries,
	nextEntry,
	entryIndex,
	usedIndexes,
}: {
	entries: PresentationWordSnapshot[];
	nextEntry: PresentationWordSnapshot;
	entryIndex: number;
	usedIndexes: Set<number>;
}): number {
	if (nextEntry.wordId) {
		const wordIdIndex = entries.findIndex(
			(entry, index) =>
				!usedIndexes.has(index) && entry.wordId === nextEntry.wordId,
		);
		if (wordIdIndex >= 0) {
			usedIndexes.add(wordIdIndex);
			return wordIdIndex;
		}
	}

	if (entries[entryIndex] && !usedIndexes.has(entryIndex)) {
		usedIndexes.add(entryIndex);
		return entryIndex;
	}

	const normalizedEntry = normalizeTranscriptText({ text: nextEntry.text });
	const textIndex = entries.findIndex(
		(entry, index) =>
			!usedIndexes.has(index) &&
			normalizeTranscriptText({ text: entry.text }) === normalizedEntry,
	);
	if (textIndex >= 0) {
		usedIndexes.add(textIndex);
		return textIndex;
	}

	return -1;
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

function hasElementTranscriptSemanticChange({
	previousTracks,
	nextElement,
	update,
}: {
	previousTracks: SceneTracks;
	nextElement: TextElement;
	update: UpdatedElementRef;
}) {
	const previousElement = findTextElementInTracks({
		tracks: previousTracks,
		trackId: update.trackId,
		elementId: update.elementId,
	});
	if (!previousElement) return true;
	if (
		isPresentationOnlyWordRunElement({ element: previousElement }) ||
		isPresentationOnlyWordRunElement({ element: nextElement })
	) {
		return !arePresentationWordSnapshotsEqual({
			left: getElementPresentationWordSnapshots({ element: previousElement }),
			right: getElementPresentationWordSnapshots({ element: nextElement }),
		});
	}
	return !areTranscriptWordSnapshotsEqual({
		left: getElementTranscriptWordSnapshots({ element: previousElement }),
		right: getElementTranscriptWordSnapshots({ element: nextElement }),
	});
}

function findTextElementInTracks({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}) {
	const track = tracks.overlay.find(
		(track): track is TextTrack =>
			track.type === "text" && track.id === trackId,
	);
	return track?.elements.find((element) => element.id === elementId) ?? null;
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

function areTranscriptWordSnapshotsEqual({
	left,
	right,
}: {
	left: TranscriptWordSnapshot[];
	right: TranscriptWordSnapshot[];
}) {
	if (left.length !== right.length) return false;
	return left.every((word, index) => {
		const candidate = right[index];
		return (
			candidate?.text === word.text &&
			candidate.start === word.start &&
			candidate.end === word.end
		);
	});
}

function arePresentationWordSnapshotsEqual({
	left,
	right,
}: {
	left: PresentationWordSnapshot[];
	right: PresentationWordSnapshot[];
}) {
	if (left.length !== right.length) return false;
	return left.every((word, index) => {
		const candidate = right[index];
		return candidate?.text === word.text && candidate.wordId === word.wordId;
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

function isPresentationOnlyWordRunElement({
	element,
}: {
	element: TextElement;
}) {
	return (
		(element.wordRuns?.length ?? 0) > 0 &&
		!element.wordRuns?.some((run) => isTimedWordRun(run))
	);
}
