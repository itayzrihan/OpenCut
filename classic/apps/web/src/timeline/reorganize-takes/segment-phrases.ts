import type { TranscriptionWord } from "@/transcription/types";
import { generateUUID } from "@/utils/id";

/** A short spoken unit (roughly a sentence or clause) derived from word-level transcript data. */
export interface TakePhrase {
	id: string;
	text: string;
	/** Seconds, absolute — matches TranscriptionWord timing. */
	startTime: number;
	endTime: number;
	/** [start, end) into the source words array. */
	wordIndexRange: [number, number];
}

const SENTENCE_END_PATTERN = /[.!?…]["')\]]*$/;

/** Shorter than the cut-silence UI default — silence was likely already cut before this runs. */
export const DEFAULT_PHRASE_GAP_SECONDS = 0.6;
const MIN_PHRASE_SECONDS = 1.5;
const MIN_PHRASE_WORDS = 3;

/**
 * Deterministically groups word-level transcript data into compact phrases, splitting on
 * sentence-ending punctuation or a pause between words. This keeps what gets sent to an LLM
 * to a handful of short lines instead of hundreds of individually-timed words.
 */
export function segmentWordsIntoPhrases({
	words,
	gapThresholdSeconds = DEFAULT_PHRASE_GAP_SECONDS,
}: {
	words: TranscriptionWord[];
	gapThresholdSeconds?: number;
}): TakePhrase[] {
	if (words.length === 0) return [];

	const rawPhrases: TakePhrase[] = [];
	let start = 0;
	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		const next = words[index + 1];
		const endsSentence = SENTENCE_END_PATTERN.test(word.text.trim());
		const gapExceedsThreshold =
			next !== undefined && next.start - word.end >= gapThresholdSeconds;
		const isLastWord = next === undefined;
		if (isLastWord || endsSentence || gapExceedsThreshold) {
			rawPhrases.push(buildPhrase({ words, start, end: index }));
			start = index + 1;
		}
	}

	return mergeShortPhrases({ phrases: rawPhrases });
}

function buildPhrase({
	words,
	start,
	end,
}: {
	words: TranscriptionWord[];
	start: number;
	end: number;
}): TakePhrase {
	const slice = words.slice(start, end + 1);
	return {
		id: generateUUID(),
		text: slice
			.map((word) => word.text)
			.join(" ")
			.trim(),
		startTime: slice[0].start,
		endTime: slice[slice.length - 1].end,
		wordIndexRange: [start, end + 1],
	};
}

function mergeShortPhrases({
	phrases,
}: {
	phrases: TakePhrase[];
}): TakePhrase[] {
	const merged: TakePhrase[] = [];
	for (const phrase of phrases) {
		const wordCount = phrase.wordIndexRange[1] - phrase.wordIndexRange[0];
		const duration = phrase.endTime - phrase.startTime;
		const isShort =
			duration < MIN_PHRASE_SECONDS && wordCount < MIN_PHRASE_WORDS;
		const previous = merged[merged.length - 1];
		if (isShort && previous) {
			merged[merged.length - 1] = {
				...previous,
				text: `${previous.text} ${phrase.text}`.trim(),
				endTime: phrase.endTime,
				wordIndexRange: [previous.wordIndexRange[0], phrase.wordIndexRange[1]],
			};
		} else {
			merged.push(phrase);
		}
	}
	return merged;
}
