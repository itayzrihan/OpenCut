import { describe, expect, test } from "bun:test";
import {
	getCaptionGridCell,
	getCaptionPlacementGrid,
	normalizeCaptionLayoutSettings,
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
		expect(normalizeCaptionLayoutSettings({ settings: undefined })).toMatchObject(
			{
				revealMode: "determined-by-preset",
				transitionIn: "none",
				wordAnimationId: "none",
			},
		);
	});

	test("strips punctuation without collapsing caption lines", () => {
		expect(stripCaptionPunctuation({ text: "Hello, world." })).toBe(
			"Hello world",
		);
		expect(stripCaptionPunctuation({ text: "One!\nTwo?" })).toBe("One\nTwo");
	});
});
