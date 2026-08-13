import { describe, expect, test } from "bun:test";
import {
	applyCaptionRowRearrangement,
	applyTranscriptCorrections,
	buildMessageOptimizationRanges,
	removeCaptionLayerDuplicateWords,
	validateCaptionRowEndPositions,
	type IndexedTranscriptWord,
} from "@/subtitles/caption-ai";

const words: IndexedTranscriptWord[] = [
	{ sourceIndex: 0, text: "זה", start: 0, end: 0.2 },
	{ sourceIndex: 1, text: "בעצם", start: 0.3, end: 0.6 },
	{ sourceIndex: 2, text: "בעצם", start: 0.65, end: 0.9 },
	{ sourceIndex: 3, text: "המסר", start: 1, end: 1.35 },
];

describe("caption AI edits", () => {
	test("validates rearranged rows without changing word order", () => {
		expect(
			applyCaptionRowRearrangement({
				words,
				rowEndPositions: [3, 4],
				wordsPerRow: 3,
			}),
		).toEqual([3, 4]);
	});

	test("rejects row plans that skip words or exceed the configured maximum", () => {
		expect(() =>
			validateCaptionRowEndPositions({
				words,
				rowEndPositions: [3],
				wordsPerRow: 3,
			}),
		).toThrow("did not assign every transcript word");
		expect(() =>
			validateCaptionRowEndPositions({
				words,
				rowEndPositions: [4],
				wordsPerRow: 4,
			}),
		).not.toThrow();
	});

	test("changes transcript text without touching timing or source metadata", () => {
		const result = applyTranscriptCorrections({
			words: [
				{
					text: "תפל",
					start: 2,
					end: 2.4,
					source: {
						type: "text-layer",
						trackId: "captions",
						elementId: "caption-1",
						wordIndex: 0,
					},
				},
			],
			changes: [{ index: 0, text: "טפל" }],
		});

		expect(result.changedCount).toBe(1);
		expect(result.words[0]).toEqual({
			text: "טפל",
			start: 2,
			end: 2.4,
			source: {
				type: "text-layer",
				trackId: "captions",
				elementId: "caption-1",
				wordIndex: 0,
			},
		});
	});

	test("merges adjacent redundant phrases into one clean timeline cut", () => {
		const ranges = buildMessageOptimizationRanges({
			words,
			removeRanges: [
				{ startIndex: 1, endIndex: 1, reason: "filler" },
				{ startIndex: 2, endIndex: 2, reason: "repetition" },
			],
		});

		expect(ranges).toHaveLength(1);
		expect(ranges[0]).toMatchObject({
			startIndex: 1,
			endIndex: 2,
		});
		expect(ranges[0]?.start).toBeCloseTo(0.25);
		expect(ranges[0]?.end).toBeCloseTo(0.95);
	});

	test("ignores AI ranges that do not refer to supplied transcript indexes", () => {
		expect(
			buildMessageOptimizationRanges({
				words,
				removeRanges: [{ startIndex: 99, endIndex: 100, reason: "invalid" }],
			}),
		).toEqual([]);
	});

	test("removes stale caption-layer ownership words without deleting manual text", () => {
		const result = removeCaptionLayerDuplicateWords({
			words: [
				{ text: "hello", start: 0, end: 0.2 },
				{
					text: "hello",
					start: 0,
					end: 0.2,
					source: {
						type: "text-layer",
						trackId: "captions-a",
						elementId: "caption-1",
						wordIndex: 0,
					},
				},
				{
					text: "title",
					start: 1,
					end: 2,
					source: {
						type: "text-layer",
						trackId: "manual-title",
						elementId: "title-1",
						wordIndex: 0,
					},
				},
			],
			captionTrackIds: new Set(["captions-a", "captions-b"]),
		});

		expect(result.map((word) => word.text)).toEqual(["hello", "title"]);
		expect(result[1]?.source).toMatchObject({ trackId: "manual-title" });
	});
});
