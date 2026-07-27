import type { TranscriptionWord } from "@/transcription/types";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";

export const WORD_TIMING_MIN_WORD_WIDTH_PX = 8;

export type WordDragPreview = {
	wordIndex: number;
	start: number;
	end: number;
};

type VisibleWindow = { start: number; end: number };

export interface CaptionWordVisibilityIndex {
	isSortedByStart: boolean;
	maxDurationSeconds: number;
}

function getPixelsPerSecond({ zoomLevel }: { zoomLevel: number }) {
	return BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
}

export function getCaptionWordVisibilityIndex({
	words,
}: {
	words: TranscriptionWord[];
}): CaptionWordVisibilityIndex {
	let isSortedByStart = true;
	let maxDurationSeconds = 0;
	let previousStart = -Infinity;

	for (const word of words) {
		if (word.start < previousStart) {
			isSortedByStart = false;
		}
		previousStart = word.start;
		maxDurationSeconds = Math.max(
			maxDurationSeconds,
			Math.max(0.01, word.end - word.start),
		);
	}

	return { isSortedByStart, maxDurationSeconds };
}

export function getVisibleCaptionWordIndexes({
	words,
	dragPreview = null,
	visibleWindow,
	zoomLevel,
	visibilityIndex = getCaptionWordVisibilityIndex({ words }),
}: {
	words: TranscriptionWord[];
	dragPreview?: WordDragPreview | null;
	visibleWindow: VisibleWindow;
	zoomLevel: number;
	visibilityIndex?: CaptionWordVisibilityIndex;
}): number[] {
	if (words.length === 0) return [];

	const pixelsPerSecond = getPixelsPerSecond({ zoomLevel });
	if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
		return words.map((_, index) => index);
	}

	const visibleStartSeconds = visibleWindow.start / pixelsPerSecond;
	const visibleEndSeconds = visibleWindow.end / pixelsPerSecond;
	const forcedWordIndex = dragPreview?.wordIndex ?? null;

	if (!visibilityIndex.isSortedByStart) {
		return getVisibleCaptionWordIndexesLinear({
			words,
			dragPreview,
			visibleStartSeconds,
			visibleEndSeconds,
			pixelsPerSecond,
			forcedWordIndex,
		});
	}

	const minWidthSeconds = WORD_TIMING_MIN_WORD_WIDTH_PX / pixelsPerSecond;
	const startIndex = lowerBoundWordStart({
		words,
		time: Math.max(
			0,
			visibleStartSeconds -
				Math.max(visibilityIndex.maxDurationSeconds, minWidthSeconds),
		),
	});
	const endIndex = upperBoundWordStart({
		words,
		time: visibleEndSeconds,
	});
	const indexSet = new Set<number>();

	for (let index = startIndex; index < endIndex; index++) {
		const timing = getVisibleWordTiming({
			word: words[index],
			index,
			dragPreview,
		});

		if (
			timing.start <= visibleEndSeconds &&
			getVisibleWordEndSeconds({ timing, pixelsPerSecond }) >=
				visibleStartSeconds
		) {
			indexSet.add(index);
		}
	}

	if (forcedWordIndex !== null && words[forcedWordIndex]) {
		indexSet.add(forcedWordIndex);
	}

	return [...indexSet].sort((a, b) => a - b);
}

function getVisibleCaptionWordIndexesLinear({
	words,
	dragPreview,
	visibleStartSeconds,
	visibleEndSeconds,
	pixelsPerSecond,
	forcedWordIndex,
}: {
	words: TranscriptionWord[];
	dragPreview: WordDragPreview | null;
	visibleStartSeconds: number;
	visibleEndSeconds: number;
	pixelsPerSecond: number;
	forcedWordIndex: number | null;
}): number[] {
	const indexes: number[] = [];

	for (let index = 0; index < words.length; index++) {
		const isForcedWord = index === forcedWordIndex;
		const timing = getVisibleWordTiming({
			word: words[index],
			index,
			dragPreview,
		});

		if (
			isForcedWord ||
			(timing.start <= visibleEndSeconds &&
				getVisibleWordEndSeconds({ timing, pixelsPerSecond }) >=
					visibleStartSeconds)
		) {
			indexes.push(index);
		}
	}

	return indexes;
}

export function getVisibleWordTiming({
	word,
	index,
	dragPreview,
}: {
	word: TranscriptionWord;
	index: number;
	dragPreview: WordDragPreview | null;
}) {
	if (dragPreview?.wordIndex === index) {
		return {
			start: dragPreview.start,
			end: Math.max(dragPreview.start + 0.01, dragPreview.end),
		};
	}

	return {
		start: word.start,
		end: Math.max(word.start + 0.01, word.end),
	};
}

function getVisibleWordEndSeconds({
	timing,
	pixelsPerSecond,
}: {
	timing: { start: number; end: number };
	pixelsPerSecond: number;
}) {
	return (
		timing.start +
		Math.max(
			timing.end - timing.start,
			WORD_TIMING_MIN_WORD_WIDTH_PX / pixelsPerSecond,
		)
	);
}

function lowerBoundWordStart({
	words,
	time,
}: {
	words: TranscriptionWord[];
	time: number;
}) {
	let low = 0;
	let high = words.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (words[mid].start < time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function upperBoundWordStart({
	words,
	time,
}: {
	words: TranscriptionWord[];
	time: number;
}) {
	let low = 0;
	let high = words.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (words[mid].start <= time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}
