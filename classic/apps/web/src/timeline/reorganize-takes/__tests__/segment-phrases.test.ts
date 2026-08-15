import { describe, expect, test } from "bun:test";
import type { TranscriptionWord } from "@/transcription/types";
import { segmentWordsIntoPhrases } from "../segment-phrases";

function word({
	text,
	start,
	end,
}: {
	text: string;
	start: number;
	end: number;
}): TranscriptionWord {
	return { text, start, end };
}

describe("segmentWordsIntoPhrases", () => {
	test("splits on sentence-ending punctuation", () => {
		const words: TranscriptionWord[] = [
			word({ text: "Hello", start: 0, end: 0.3 }),
			word({ text: "there.", start: 0.3, end: 0.6 }),
			word({ text: "How", start: 0.65, end: 0.9 }),
			word({ text: "are", start: 0.9, end: 1.1 }),
			word({ text: "you?", start: 1.1, end: 1.4 }),
		];

		const phrases = segmentWordsIntoPhrases({ words });

		expect(phrases.map((phrase) => phrase.text)).toEqual([
			"Hello there.",
			"How are you?",
		]);
		expect(phrases[0]?.wordIndexRange).toEqual([0, 2]);
		expect(phrases[1]?.wordIndexRange).toEqual([2, 5]);
	});

	test("splits on a pause between words even without punctuation", () => {
		const words: TranscriptionWord[] = [
			word({ text: "This", start: 0, end: 0.2 }),
			word({ text: "is", start: 0.2, end: 0.35 }),
			word({ text: "the", start: 0.35, end: 0.5 }),
			word({ text: "first", start: 0.5, end: 0.7 }),
			word({ text: "part", start: 0.7, end: 0.9 }),
			// 1.0s gap, well over the default 0.6s threshold
			word({ text: "second", start: 1.9, end: 2.1 }),
			word({ text: "part", start: 2.1, end: 2.3 }),
			word({ text: "here", start: 2.3, end: 2.5 }),
		];

		const phrases = segmentWordsIntoPhrases({ words });

		expect(phrases.map((phrase) => phrase.text)).toEqual([
			"This is the first part",
			"second part here",
		]);
	});

	test("merges phrases that are too short to stand alone", () => {
		const words: TranscriptionWord[] = [
			word({ text: "Um.", start: 0, end: 0.2 }),
			word({ text: "So", start: 1, end: 1.2 }),
			word({ text: "anyway,", start: 1.2, end: 1.5 }),
			word({ text: "here", start: 1.5, end: 1.7 }),
			word({ text: "we", start: 1.7, end: 1.9 }),
			word({ text: "go.", start: 1.9, end: 2.1 }),
		];

		const phrases = segmentWordsIntoPhrases({ words });

		// The lone "Um." fragment is too short/word-sparse to stand alone and has no
		// predecessor to merge into, so it survives as its own short leading phrase.
		expect(phrases.length).toBe(2);
		expect(phrases[0]?.text).toBe("Um.");
		expect(phrases[1]?.text).toBe("So anyway, here we go.");
	});

	test("handles non-Latin (Hebrew) punctuation the same way", () => {
		const words: TranscriptionWord[] = [
			word({ text: "שלום", start: 0, end: 0.2 }),
			word({ text: "עולם", start: 0.2, end: 0.35 }),
			word({ text: "יפה.", start: 0.35, end: 0.55 }),
			word({ text: "מה", start: 0.6, end: 0.75 }),
			word({ text: "שלומך", start: 0.75, end: 0.95 }),
			word({ text: "היום?", start: 0.95, end: 1.15 }),
		];

		const phrases = segmentWordsIntoPhrases({ words });

		expect(phrases.map((phrase) => phrase.text)).toEqual([
			"שלום עולם יפה.",
			"מה שלומך היום?",
		]);
	});

	test("returns an empty array for no words", () => {
		expect(segmentWordsIntoPhrases({ words: [] })).toEqual([]);
	});

	test("every phrase gets a stable unique id", () => {
		const words: TranscriptionWord[] = [
			word({ text: "One.", start: 0, end: 0.3 }),
			word({ text: "Two.", start: 1, end: 1.3 }),
		];

		const phrases = segmentWordsIntoPhrases({ words });
		const ids = new Set(phrases.map((phrase) => phrase.id));
		expect(ids.size).toBe(phrases.length);
	});
});
