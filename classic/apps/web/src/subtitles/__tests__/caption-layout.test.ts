import { describe, expect, test } from "bun:test";
import {
	buildCaptionChunksFromWords,
	getCaptionGridCell,
	getCaptionPlacementGrid,
	normalizeCaptionLayoutSettings,
	resolveCaptionBottomFadeOut,
	stripCaptionPunctuation,
} from "@/subtitles/caption-layout";

describe("caption placement layout", () => {
	test("selects a grid from the canvas ratio", () => {
		expect(
			getCaptionPlacementGrid({ canvasSize: { width: 1080, height: 1080 } }),
		).toEqual({ columns: 3, rows: 3 });
		expect(
			getCaptionPlacementGrid({ canvasSize: { width: 1920, height: 1080 } }),
		).toEqual({ columns: 5, rows: 3 });
		expect(
			getCaptionPlacementGrid({ canvasSize: { width: 1080, height: 1920 } }),
		).toEqual({ columns: 3, rows: 5 });
	});

	test("defaults to bottom-center in each ratio grid", () => {
		const settings = normalizeCaptionLayoutSettings({ settings: undefined });

		expect(
			getCaptionGridCell({
				settings,
				canvasSize: { width: 1080, height: 1080 },
			}),
		).toEqual({ columns: 3, rows: 3, columnIndex: 1, rowIndex: 2 });
		expect(
			getCaptionGridCell({
				settings,
				canvasSize: { width: 1920, height: 1080 },
			}),
		).toEqual({ columns: 5, rows: 3, columnIndex: 2, rowIndex: 2 });
		expect(
			getCaptionGridCell({
				settings,
				canvasSize: { width: 1080, height: 1920 },
			}),
		).toEqual({ columns: 3, rows: 5, columnIndex: 1, rowIndex: 4 });
	});

	test("normalizes placement mode and coordinates", () => {
		const settings = normalizeCaptionLayoutSettings({
			settings: {
				placementMode: "manual",
				placementGridX: 2,
				placementGridY: -1,
				manualPositionX: 123,
				manualPositionY: -456,
			},
		});

		expect(settings.placementMode).toBe("manual");
		expect(settings.placementGridX).toBe(1);
		expect(settings.placementGridY).toBe(0);
		expect(settings.manualPositionX).toBe(123);
		expect(settings.manualPositionY).toBe(-456);
	});

	test("normalizes punctuation hiding", () => {
		expect(
			normalizeCaptionLayoutSettings({
				settings: { hidePunctuation: true },
			}).hidePunctuation,
		).toBe(true);
		expect(
			normalizeCaptionLayoutSettings({
				settings: undefined,
			}).hidePunctuation,
		).toBe(false);
	});

	test("defaults to no word animation", () => {
		expect(
			normalizeCaptionLayoutSettings({ settings: undefined }),
		).toMatchObject({
			bottomFadeOutPercent: 50,
			revealMode: "determined-by-preset",
			transitionIn: "none",
			wordAnimationId: "none",
		});
	});

	test("normalizes caption bottom fade and keeps zero as an explicit opt-out", () => {
		const defaultSettings = normalizeCaptionLayoutSettings({
			settings: undefined,
		});
		expect(
			resolveCaptionBottomFadeOut({ settings: defaultSettings }),
		).toBeCloseTo(0.5);
		expect(
			normalizeCaptionLayoutSettings({
				settings: { bottomFadeOutPercent: 150 },
			}).bottomFadeOutPercent,
		).toBe(100);
		expect(
			normalizeCaptionLayoutSettings({
				settings: { bottomFadeOutPercent: 0 },
			}).bottomFadeOutPercent,
		).toBe(0);
		expect(
			resolveCaptionBottomFadeOut({
				settings: {
					...defaultSettings,
					bottomFadeOutPercent: 0,
				},
			}),
		).toBe(0);
		expect(
			resolveCaptionBottomFadeOut({
				settings: {
					...defaultSettings,
					bottomFadeOutPercent: undefined,
				},
			}),
		).toBe(0);
	});

	test("strips punctuation without collapsing caption lines", () => {
		expect(stripCaptionPunctuation({ text: "Hello, world." })).toBe(
			"Hello world",
		);
		expect(stripCaptionPunctuation({ text: "One!\nTwo?" })).toBe("One\nTwo");
	});

	test("shares free time between consecutive one-word layers without overlap", () => {
		const settings = normalizeCaptionLayoutSettings({
			settings: {
				wordsPerRow: 1,
				rows: 1,
				inPaddingPercent: 0,
				outPaddingPercent: 0,
			},
		});
		const captions = buildCaptionChunksFromWords({
			words: [
				{ text: "One", start: 0, end: 0.1 },
				{ text: "Two", start: 0.4, end: 0.5 },
				{ text: "Three", start: 0.9, end: 1 },
			],
			settings,
		});

		expect(captions).toHaveLength(3);
		expect(captions[0]?.startTime).toBe(0);
		expect(captions[0]?.startTime + (captions[0]?.duration ?? 0)).toBeCloseTo(
			0.25,
		);
		expect(captions[1]?.startTime).toBeCloseTo(0.25);
		expect(captions[1]?.startTime + (captions[1]?.duration ?? 0)).toBeCloseTo(
			0.7,
		);
		expect(captions[2]?.startTime).toBeCloseTo(0.7);
	});

	test("preserves source overlap instead of treating it as free reading time", () => {
		const settings = normalizeCaptionLayoutSettings({
			settings: {
				wordsPerRow: 1,
				rows: 1,
				inPaddingPercent: 0,
				outPaddingPercent: 0,
			},
		});
		const captions = buildCaptionChunksFromWords({
			words: [
				{ text: "Hello", start: 0.5, end: 1.5 },
				{ text: "world", start: 1.2, end: 2 },
			],
			settings,
		});

		expect(captions[0]).toMatchObject({ startTime: 0.5, duration: 1 });
		expect(captions[1]).toMatchObject({ startTime: 1.2, duration: 0.8 });
	});

	test("uses semantic row breaks while preserving the words-per-row cap", () => {
		const settings = normalizeCaptionLayoutSettings({
			settings: {
				wordsPerRow: 3,
				rows: 2,
				rowBreaks: [2, 3, 5, 6],
				inPaddingPercent: 0,
				outPaddingPercent: 0,
			},
		});
		const captions = buildCaptionChunksFromWords({
			words: [
				{ text: "If", start: 0, end: 0.2 },
				{ text: "you", start: 0.2, end: 0.4 },
				{ text: "leave", start: 0.4, end: 0.6 },
				{ text: "the", start: 0.6, end: 0.8 },
				{ text: "room", start: 0.8, end: 1 },
				{ text: "now", start: 1, end: 1.2 },
			],
			settings,
		});

		expect(captions).toHaveLength(2);
		expect(captions[0]?.text).toBe("If you\nleave");
		expect(captions[1]?.text).toBe("the room\nnow");
		expect(
			captions
				.flatMap((caption) => caption.words ?? [])
				.map((word) => word.text),
		).toEqual(["If", "you", "leave", "the", "room", "now"]);
	});
});
