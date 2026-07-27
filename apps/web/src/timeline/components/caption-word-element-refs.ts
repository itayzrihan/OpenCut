import type { SelectedTextWordRef } from "@/selection/editor-selection";
import { stripCaptionPunctuation } from "@/subtitles/caption-layout";
import type { TextElement, TextTrack } from "@/timeline/types";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTimeToSeconds } from "@/wasm/media-time";

export function getWordElementRefs({
	words,
	sourceTracks,
	includePresentationOnly = false,
}: {
	words: TranscriptionWord[];
	sourceTracks: TextTrack[];
	includePresentationOnly?: boolean;
}): Map<number, SelectedTextWordRef[]> {
	const refsByWordIndex = new Map<number, SelectedTextWordRef[]>();
	for (const [wordIndex, word] of words.entries()) {
		if (word.source?.type !== "text-layer") continue;
		refsByWordIndex.set(wordIndex, [
			...(refsByWordIndex.get(wordIndex) ?? []),
			{
				trackId: word.source.trackId,
				elementId: word.source.elementId,
				wordId: word.source.wordId ?? `word-${word.source.wordIndex}`,
			},
		]);
	}

	for (const track of sourceTracks) {
		for (const element of track.elements) {
			if (
				includePresentationOnly &&
				isPresentationOnlyWordRunElement({ element })
			) {
				for (const { wordIndex, run } of getPresentationOnlyWordRunRefs({
					words,
					element,
				})) {
					refsByWordIndex.set(wordIndex, [
						...(refsByWordIndex.get(wordIndex) ?? []),
						{
							trackId: track.id,
							elementId: element.id,
							wordId: run.id,
						},
					]);
				}
				continue;
			}

			const elementStart = mediaTimeToSeconds({ time: element.startTime });
			for (const run of element.wordRuns ?? []) {
				if (!isTimedWordRun(run)) continue;
				const runStart =
					elementStart + mediaTimeToSeconds({ time: run.startTime });
				const runEnd = elementStart + mediaTimeToSeconds({ time: run.endTime });
				const wordIndex = findWordIndexForRun({ words, run, runStart, runEnd });
				if (wordIndex < 0) continue;

				refsByWordIndex.set(wordIndex, [
					...(refsByWordIndex.get(wordIndex) ?? []),
					{
						trackId: track.id,
						elementId: element.id,
						wordId: run.id,
					},
				]);
			}
		}
	}

	return refsByWordIndex;
}

function getPresentationOnlyWordRunRefs({
	words,
	element,
}: {
	words: TranscriptionWord[];
	element: TextElement;
}): Array<{
	wordIndex: number;
	run: NonNullable<TextElement["wordRuns"]>[number];
}> {
	const usedWordIndexes = new Set<number>();
	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const elementEnd =
		elementStart + mediaTimeToSeconds({ time: element.duration });
	let searchStart = 0;

	return (element.wordRuns ?? []).flatMap((run) => {
		const normalizedText = normalizeWord(run.text);
		if (!normalizedText) return [];

		let wordIndex = findPresentationWordIndex({
			words,
			normalizedText,
			usedWordIndexes,
			searchStart,
			elementStart,
			elementEnd,
		});
		if (wordIndex < 0) {
			wordIndex = findPresentationWordIndex({
				words,
				normalizedText,
				usedWordIndexes,
				searchStart: 0,
				elementStart,
				elementEnd,
			});
		}
		if (wordIndex < 0) return [];

		usedWordIndexes.add(wordIndex);
		searchStart = wordIndex + 1;
		return [{ wordIndex, run }];
	});
}

function findPresentationWordIndex({
	words,
	normalizedText,
	usedWordIndexes,
	searchStart,
	elementStart,
	elementEnd,
}: {
	words: TranscriptionWord[];
	normalizedText: string;
	usedWordIndexes: Set<number>;
	searchStart: number;
	elementStart: number;
	elementEnd: number;
}) {
	let fallbackIndex = -1;
	for (let index = searchStart; index < words.length; index++) {
		const word = words[index];
		if (!word || usedWordIndexes.has(index)) continue;
		if (word.source?.type === "text-layer") continue;
		if (normalizeWord(word.text) !== normalizedText) continue;
		fallbackIndex = fallbackIndex < 0 ? index : fallbackIndex;
		const midpoint = (word.start + word.end) / 2;
		if (midpoint >= elementStart - 0.001 && midpoint <= elementEnd + 0.001) {
			return index;
		}
	}
	return fallbackIndex;
}

export function findWordIndexForRun({
	words,
	run,
	runStart,
	runEnd,
}: {
	words: TranscriptionWord[];
	run: NonNullable<TextElement["wordRuns"]>[number];
	runStart: number;
	runEnd: number;
}) {
	const normalizedText = normalizeWord(run.text);
	if (!normalizedText) return -1;
	let bestIndex = -1;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		if (normalizeWord(word.text) !== normalizedText) continue;
		const score = Math.abs(word.start - runStart) + Math.abs(word.end - runEnd);
		if (score < bestScore) {
			bestIndex = index;
			bestScore = score;
		}
	}
	return bestIndex;
}

function normalizeWord(value: string) {
	return stripCaptionPunctuation({ text: value }).toLocaleLowerCase();
}

export function isTimedWordRun(
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
