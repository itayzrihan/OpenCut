// @opencut-test-wasm: real
import { afterAll, beforeAll, expect, test } from "bun:test";
import { DEFAULTS } from "@/timeline/defaults";
import { DEFAULT_CAPTION_LAYOUT } from "../caption-layout";
import { buildCaptionText } from "opencut-wasm";
import type { SubtitleCue } from "../types";
import { buildSubtitleTextElement } from "../build-subtitle-text-element";
import { buildSubtitleTextElement as legacy } from "./legacy-build-subtitle-text-element-fixture";

const previousDocument = Object.getOwnPropertyDescriptor(
	globalThis,
	"document",
);
let measured = false;
beforeAll(() =>
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => ({
				width: 0,
				height: 0,
				getContext: () =>
					measured
						? {
								font: "",
								letterSpacing: "0px",
								measureText(text: string) {
									const size = Number.parseFloat(
										this.font.match(/([\d.e+-]+)px/)?.[1] ?? "12",
									);
									const glyphs = Array.from(text).length;
									return {
										width:
											glyphs * size * 0.55 +
											Math.max(0, glyphs - 1) *
												Number.parseFloat(this.letterSpacing),
									};
								},
							}
						: null,
			}),
		},
	}),
);
afterAll(() => {
	if (previousDocument)
		Object.defineProperty(globalThis, "document", previousDocument);
	else Reflect.deleteProperty(globalThis, "document");
});
function serial(value: unknown) {
	return JSON.parse(JSON.stringify(value));
}

test("Rust builds the same caption clips with measured glyphs and unavailable-canvas fallback", () => {
	let modes = 0;
	for (const measure of [false, true])
		for (const canvasSize of [
			{ width: 1920, height: 1080 },
			{ width: 160, height: 1080 },
			{ width: 1080, height: 1080 },
		]) {
			measured = measure;
			for (const placementMode of [undefined, "manual", "grid"] as const)
				for (const background of [false, true]) {
					for (const text of [
						"שלום, world! כן?",
						"one\n two three",
						"  one \t\n two  ",
						"",
						"... , !",
						"\ufeffone\u00a0two\u0085three",
					]) {
						for (const explicitWords of [false, true]) {
							const caption: SubtitleCue = {
								text,
								startTime: 0.123456,
								duration: 1.234567,
								words: explicitWords
									? [
											{ text: "שלום,", start: 0.123456, end: 0.3 },
											{ text: "world!", start: 0.31, end: 0.8 },
											{ text: "כן?", start: 0.81, end: 1.3 },
										]
									: undefined,
								style: {
									fontFamily: 'Font "quoted"',
									fontSizeRatioOfPlayHeight: 0.031,
									fontWeight: "700",
									fontStyle: "italic",
									textAlign: "right",
									letterSpacing: 1.25,
									lineHeight: 1.35,
									background: {
										enabled: background,
										color: "#112233",
										paddingX: 23.5,
										paddingY: 18.25,
										offsetX: -7,
										offsetY: 11,
									},
									placement: {
										verticalAlign: "top",
										marginLeftRatio: 0.1,
										marginRightRatio: 0.2,
										marginVerticalRatio: 0.04,
									},
								},
							};
							const input = {
								index: 3,
								caption,
								canvasSize,
								revealMode: "spoken-word-keep" as const,
								transitionIn: "rise" as const,
								wordAnimationId: "pulse",
								accentColor: "#ffcc00",
								wordDirection: "rtl" as const,
								layoutSettings: placementMode
									? {
											...DEFAULT_CAPTION_LAYOUT,
											placementMode,
											manualPositionX: 23,
											manualPositionY: -9,
											placementGridX: 0.9,
											placementGridY: 0.1,
											hidePunctuation: true,
										}
									: undefined,
							};
							const before = serial(input);
							expect(serial(buildSubtitleTextElement(input))).toEqual(
								serial(legacy(input)),
							);
							expect(serial(input)).toEqual(before);
							modes++;
						}
					}
				}
		}
	expect(modes).toBe(432);
});

test("the width-only bridge rejects failed or invalid measurements without publishing a clip", () => {
	const inputJson = JSON.stringify({
		index: 0,
		caption: { text: "one two", startTime: 0, duration: 1 },
		canvasSize: { width: 100, height: 100 },
		defaults: DEFAULTS.text,
		fontSizeScaleReference: 90,
	});
	expect(() => buildCaptionText({ inputJson, measure: () => NaN })).toThrow(
		"Invalid caption glyph width",
	);
	expect(() =>
		buildCaptionText({
			inputJson,
			measure: () => {
				throw new Error("private host detail");
			},
		}),
	).toThrow("Caption measurement failed");
	expect(() => buildCaptionText({ inputJson: "invalid" })).toThrow(
		"Invalid caption builder input",
	);
	expect(serial(JSON.parse(buildCaptionText({ inputJson })))).toHaveProperty(
		"type",
		"text",
	);
});
