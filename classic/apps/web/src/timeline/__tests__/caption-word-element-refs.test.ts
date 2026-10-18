// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import {
	createCaptionWordIndex,
	findWordIndexForRun,
} from "../components/caption-word-element-refs";
import type { TranscriptionWord } from "@/transcription/types";

test("indexed matching retains punctuation, case, closest timing and first-index ties", () => {
	const words = [
		{ text: "שלום!", start: 20, end: 21 },
		{ text: "שלום", start: 2, end: 3 },
		{ text: "שלום", start: 2, end: 3 },
		{ text: "HELLO,", start: 5, end: 6 },
	];
	const lookup = createCaptionWordIndex({ words });
	const find = (text: string, runStart: number, runEnd: number) =>
		findWordIndexForRun({
			words,
			lookup,
			run: { id: "run", lineIndex: 0, text },
			runStart,
			runEnd,
		});
	expect(find("שלום.", 2, 3)).toBe(1);
	expect(find("שלום", 19, 20)).toBe(0);
	expect(find("hello", 5, 6)).toBe(3);
	expect(find("missing", 5, 6)).toBe(-1);
	expect(find("...", 5, 6)).toBe(-1);
	words[1].text = "changed";
	expect(
		findWordIndexForRun({
			words,
			lookup: createCaptionWordIndex({ words }),
			run: { id: "run", lineIndex: 0, text: "שלום" },
			runStart: 2,
			runEnd: 3,
		}),
	).toBe(2);
});

test("a long transcript is normalized once, not once per displayed word", () => {
	let reads = 0;
	const words: TranscriptionWord[] = Array.from(
		{ length: 12000 },
		(_, index) => ({
			get text() {
				reads++;
				return `word${index % 100}`;
			},
			start: index,
			end: index + 0.5,
		}),
	);
	const lookup = createCaptionWordIndex({ words });
	for (let index = 0; index < words.length; index++) {
		expect(
			findWordIndexForRun({
				words,
				lookup,
				run: { id: `r${index}`, lineIndex: 0, text: `word${index % 100}` },
				runStart: index,
				runEnd: index + 0.5,
			}),
		).toBe(index);
	}
	expect(reads).toBe(words.length);
});
