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
			words: [{ text: "עכשיו", start: 4, end: 4.12 }],
			startTime: 4,
			endTime: 4.12,
		});

		expect(bounds.endTime).toBe(4.12);
		expect(bounds.startTime).toBeCloseTo(
			4.12 - MIN_SINGLE_WORD_VISIBLE_SECONDS,
		);
	});

	test("moves the final visual word earlier and hands off from the previous word", () => {
		const timings = getReadableWordTimings({
			words: [
				{ text: "מסר", start: 1, end: 1.7 },
				{ text: "מדויק", start: 1.7, end: 1.82 },
			],
			captionStartTime: 1,
			captionEndTime: 1.82,
		});

		expect(timings[1]?.end).toBe(1.82);
		expect(timings[1]?.start).toBeCloseTo(1.82 - MIN_LAST_WORD_VISIBLE_SECONDS);
		expect(timings[0]?.end).toBe(timings[1]?.start);
	});

	test("never moves a one-word caption before the timeline starts", () => {
		const bounds = getReadableCaptionBounds({
			words: [{ text: "Hi", start: 0.08, end: 0.16 }],
			startTime: 0.08,
			endTime: 0.16,
		});

		expect(bounds).toEqual({ startTime: 0, endTime: 0.16 });
	});
});
