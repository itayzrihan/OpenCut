import { describe, expect, test } from "bun:test";
import {
	getReadableCaptionBounds,
	getReadableWordTimings,
	MIN_LAST_WORD_VISIBLE_SECONDS,
	MIN_SINGLE_WORD_VISIBLE_SECONDS,
} from "@/subtitles/caption-readable-timing";

describe("readable caption timing", () => {
	test("starts a one-word layer earlier without moving its end", () => {
		const bounds = getReadableCaptionBounds({
			words: [{ text: "Now", start: 4, end: 4.12 }],
			startTime: 4,
			endTime: 4.12,
		});

		expect(bounds.endTime).toBe(4.12);
		expect(bounds.startTime).toBeCloseTo(
			4.12 - MIN_SINGLE_WORD_VISIBLE_SECONDS,
		);
	});

	test("moves the final visual word earlier only inside the preceding gap", () => {
		const timings = getReadableWordTimings({
			words: [
				{ text: "message", start: 1, end: 1.3 },
				{ text: "precise", start: 1.7, end: 1.82 },
			],
			captionStartTime: 1,
			captionEndTime: 1.82,
		});

		expect(timings[1]?.end).toBe(1.82);
		expect(timings[1]?.start).toBeCloseTo(
			Math.max(1.3, 1.82 - MIN_LAST_WORD_VISIBLE_SECONDS),
		);
		expect(timings[0]).toEqual({ start: 1, end: 1.3 });
	});

	test("does not move the final word across the word before it", () => {
		const timings = getReadableWordTimings({
			words: [
				{ text: "almost", start: 1, end: 1.7 },
				{ text: "done", start: 1.7, end: 1.82 },
			],
			captionStartTime: 1,
			captionEndTime: 1.82,
		});

		expect(timings[0]).toEqual({ start: 1, end: 1.7 });
		expect(timings[1]).toEqual({ start: 1.7, end: 1.82 });
	});

	test("never moves a one-word caption before the timeline starts", () => {
		const bounds = getReadableCaptionBounds({
			words: [{ text: "Hi", start: 0.08, end: 0.16 }],
			startTime: 0.08,
			endTime: 0.16,
		});

		expect(bounds).toEqual({ startTime: 0, endTime: 0.16 });
	});

	test("uses free time on both sides of a single word without crossing captions", () => {
		const bounds = getReadableCaptionBounds({
			words: [{ text: "Now", start: 4, end: 4.12 }],
			startTime: 4,
			endTime: 4.12,
			previousCaptionEndTime: 3.9,
			nextCaptionStartTime: 4.5,
		});

		expect(bounds.startTime).toBe(3.9);
		expect(bounds.endTime).toBeCloseTo(4.5);
		expect(bounds.endTime - bounds.startTime).toBeCloseTo(
			MIN_SINGLE_WORD_VISIBLE_SECONDS,
		);
	});

	test("keeps a single word visible for its entire bounded reading window", () => {
		const timings = getReadableWordTimings({
			words: [{ text: "Now", start: 4, end: 4.12 }],
			captionStartTime: 3.9,
			captionEndTime: 4.5,
		});

		expect(timings).toEqual([{ start: 3.9, end: 4.5 }]);
	});
});
