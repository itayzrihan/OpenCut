import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import {
	readScopedTextParamValue,
	textParamToScopedPatch,
} from "@/components/editor/panels/properties/text-scope";
import { TEXT_PARAM_KEYS } from "@/components/editor/panels/properties/text-param-keys";
import { getBuiltInElementParams } from "@/params/registry";
import {
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import {
	drawMeasuredTextLayout,
	getBottomFadeOutRange,
} from "@/text/primitives";
import type { TextElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function createTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		...DEFAULTS.text.element,
		...overrides,
		id: overrides.id ?? "text-bottom-fade",
		params: {
			...DEFAULTS.text.element.params,
			...(overrides.params ?? {}),
		},
	};
}

describe("bottom text fade out", () => {
	test("places the percentage control directly below Background Enabled", () => {
		const params = getBuiltInElementParams({ type: "text" });
		const backgroundIndex = params.findIndex(
			(param) => param.key === "background.enabled",
		);
		const fade = params[backgroundIndex + 1];

		expect(fade).toMatchObject({
			key: "bottomFadeOut",
			label: "Bottom Fade Out",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			step: 1,
			displayMultiplier: 100,
			shortLabel: "%",
		});
		expect(
			TEXT_PARAM_KEYS.indexOf("bottomFadeOut"),
		).toBe(TEXT_PARAM_KEYS.indexOf("background.enabled") + 1);
		const endOpacity = params.find(
			(param) => param.key === "bottomFadeOutEndOpacity",
		);
		expect(endOpacity).toMatchObject({
			key: "bottomFadeOutEndOpacity",
			label: "Fade Out End Opacity",
			type: "number",
			default: 0,
			min: 0,
			max: 100,
			displayMultiplier: 100,
			shortLabel: "%",
		});
	});

	test("expands the feather upward while keeping the bottom transparent", () => {
		expect(
			getBottomFadeOutRange({ top: 10, bottom: 110, strength: 0.25 }),
		).toEqual({ start: 85, end: 110 });
		expect(
			getBottomFadeOutRange({ top: 10, bottom: 110, strength: 1 }),
		).toEqual({ start: 10, end: 110 });
		expect(
			getBottomFadeOutRange({ top: 10, bottom: 110, strength: 2 }),
		).toEqual({ start: 10, end: 110 });
	});

	test("resolves the layer value and word-scoped overrides", () => {
		const element = createTextElement({
			params: {
				...DEFAULTS.text.element.params,
				content: "Fade",
				bottomFadeOut: 0.6,
				bottomFadeOutEndOpacity: 0.5,
				"shadow.window": true,
			},
			wordRuns: [
				{
					id: "fade",
					text: "Fade",
					lineIndex: 0,
					startTime: ZERO_MEDIA_TIME,
					endTime: mediaTime({ ticks: 1 }),
					style: { bottomFadeOut: 0.25, bottomFadeOutEndOpacity: 0.35 },
				},
			],
			captionRevealMode: "row",
		});
		const measured = measureTextElement({
			element,
			canvasHeight: 1080,
			localTime: 0.5,
			ctx: getTextMeasurementContext(),
		});

		expect(measured.bottomFadeOut).toBe(0.6);
		expect(measured.bottomFadeOutEndOpacity).toBe(0.5);
		expect(measured.windowShadow).toBe(true);
		expect(measured.wordLines?.[0]?.words[0]?.bottomFadeOut).toBe(0.25);
		expect(
			measured.wordLines?.[0]?.words[0]?.bottomFadeOutEndOpacity,
		).toBe(0.35);
		expect(
			textParamToScopedPatch({ key: "bottomFadeOut", value: 0.4 }),
		).toEqual({ style: { bottomFadeOut: 0.4 } });
		expect(
			textParamToScopedPatch({
				key: "bottomFadeOutEndOpacity",
				value: 0.5,
			}),
		).toEqual({ style: { bottomFadeOutEndOpacity: 0.5 } });
		expect(
			readScopedTextParamValue({
				element,
				scope: { type: "word", wordId: "fade" },
				key: "bottomFadeOut",
				fallbackValue: 0,
			}),
		).toBe(0.25);
		expect(
			readScopedTextParamValue({
				element,
				scope: { type: "word", wordId: "fade" },
				key: "bottomFadeOutEndOpacity",
				fallbackValue: 0,
			}),
		).toBe(0.35);
	});

	test("renders an opaque top and a transparent bottom without fading the background", () => {
		const originalOffscreenCanvas = globalThis.OffscreenCanvas;
		// @napi-rs/canvas exposes the same constructor at runtime under a
		// narrower type than the DOM OffscreenCanvas declaration.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const OffscreenCanvasPolyfill = createCanvas(
			1,
			1,
		).constructor as unknown as typeof OffscreenCanvas;
		Object.defineProperty(globalThis, "OffscreenCanvas", {
			configurable: true,
			writable: true,
			value: OffscreenCanvasPolyfill,
		});
		try {
			const canvas = createCanvas(320, 240);
			const ctx =
				// @napi-rs/canvas implements the Canvas 2D APIs used here.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
			const measured = measureTextElement({
				element: createTextElement({
					params: {
						...DEFAULTS.text.element.params,
						content: "MMMM",
						fontSize: 25,
						color: "#ffffff",
						bottomFadeOut: 1,
					},
				}),
				canvasHeight: canvas.height,
				localTime: 0,
				ctx,
			});

			ctx.translate(canvas.width / 2, canvas.height / 2);
			drawMeasuredTextLayout({
				ctx,
				layout: measured,
				textColor: "#ffffff",
				background: null,
			});

			const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			const metrics = measured.lineMetrics[0];
			const baselineY =
				canvas.height / 2 - measured.block.visualCenterOffset;
			const glyphTop = baselineY - metrics.actualBoundingBoxAscent;
			const glyphBottom = baselineY + metrics.actualBoundingBoxDescent;
			const glyphHeight = glyphBottom - glyphTop;
			const maxAlphaInBand = ({
				startY,
				endY,
			}: {
				startY: number;
				endY: number;
			}) => {
				let maxAlpha = 0;
				for (
					let y = Math.max(0, Math.floor(startY));
					y < Math.min(canvas.height, Math.ceil(endY));
					y += 1
				) {
					for (let x = 0; x < canvas.width; x += 1) {
						maxAlpha = Math.max(
							maxAlpha,
							pixels[(y * canvas.width + x) * 4 + 3] ?? 0,
						);
					}
				}
				return maxAlpha;
			};
			const topAlpha = maxAlphaInBand({
				startY: glyphTop + glyphHeight * 0.1,
				endY: glyphTop + glyphHeight * 0.3,
			});
			const bottomAlpha = maxAlphaInBand({
				startY: glyphTop + glyphHeight * 0.7,
				endY: glyphTop + glyphHeight * 0.9,
			});
			expect(topAlpha).toBeGreaterThan(bottomAlpha * 2);

			const backgroundCanvas = createCanvas(320, 240);
			const backgroundCtx =
				// @napi-rs/canvas implements the Canvas 2D APIs used here.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				backgroundCanvas.getContext(
					"2d",
				) as unknown as CanvasRenderingContext2D;
			const measuredWithBackground = measureTextElement({
				element: createTextElement({
					params: {
						...DEFAULTS.text.element.params,
						content: "MMMM",
						fontSize: 25,
						color: "#ffffff",
						bottomFadeOut: 1,
						"background.enabled": true,
						"background.color": "#ff0000",
						"background.paddingX": 8,
						"background.paddingY": 8,
					},
				}),
				canvasHeight: backgroundCanvas.height,
				localTime: 0,
				ctx: backgroundCtx,
			});
			backgroundCtx.translate(
				backgroundCanvas.width / 2,
				backgroundCanvas.height / 2,
			);
			drawMeasuredTextLayout({
				ctx: backgroundCtx,
				layout: measuredWithBackground,
				textColor: "#ffffff",
				background: measuredWithBackground.resolvedBackground,
				backgroundColor: "#ff0000",
			});
			const backgroundPixels = backgroundCtx.getImageData(
				0,
				0,
				backgroundCanvas.width,
				backgroundCanvas.height,
			).data;
			const centerX = Math.floor(canvas.width / 2);
			const backgroundBottomY = Math.min(
				backgroundCanvas.height - 1,
				Math.floor(
					backgroundCanvas.height / 2 +
						measuredWithBackground.visualRect.top +
						measuredWithBackground.visualRect.height -
						2,
				),
			);
			const backgroundPixel =
				(backgroundBottomY * backgroundCanvas.width + centerX) * 4;

			expect(backgroundPixels[backgroundPixel]).toBeGreaterThan(200);
			expect(backgroundPixels[backgroundPixel + 3]).toBe(255);
		} finally {
			if (originalOffscreenCanvas) {
				Object.defineProperty(globalThis, "OffscreenCanvas", {
					configurable: true,
					writable: true,
					value: originalOffscreenCanvas,
				});
			} else {
				Reflect.deleteProperty(globalThis, "OffscreenCanvas");
			}
		}
	});
});
