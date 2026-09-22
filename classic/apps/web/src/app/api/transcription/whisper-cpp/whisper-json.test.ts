import { describe, expect, test } from "bun:test";
import { buildWords } from "./whisper-json";

describe("whisper.cpp JSON word adapter", () => {
	test("ignores a collapsed decoding attempt before the valid retry", () => {
		const words = buildWords({
			segments: [
				{
					text: " לא כולם מגיעים",
					offsets: { from: 240, to: 240 },
					tokens: [" לא", " כולם", " מגיעים"].map((text) => ({
						text,
						t_dtw: 22,
						offsets: { from: 240, to: 240 },
					})),
				},
				{
					text: " לא כולם מגיעים",
					offsets: { from: 240, to: 1200 },
					tokens: [
						{ text: " לא", t_dtw: 24 },
						{ text: " כולם", t_dtw: 48 },
						{ text: " מגיעים", t_dtw: 82 },
					],
				},
			],
		});
		expect(words.map((word) => word.text)).toEqual(["לא", "כולם", "מגיעים"]);
		expect(words.map((word) => word.start)).toEqual([0.24, 0.48, 0.82]);
		expect(words.every((word) => word.end > word.start)).toBe(true);
	});

	test("keeps zero-duration tokens inside a valid segment", () => {
		const words = buildWords({
			segments: [
				{
					offsets: { from: 1000, to: 2000 },
					tokens: [
						{ text: " שלום", t_dtw: 105, offsets: { from: 1000, to: 1000 } },
					],
				},
			],
		});
		expect(words).toEqual([{ text: "שלום", start: 1.05, end: 1.17 }]);
	});
});
