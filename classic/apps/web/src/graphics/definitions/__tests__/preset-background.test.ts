import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import { presetBackgroundGraphicDefinition } from "@/graphics/definitions/preset-background";

describe("preset background graphic", () => {
	test("renders an opaque base even when effect intensity is low", () => {
		const canvas = createCanvas(16, 16);
		const ctx = canvas.getContext("2d");

		presetBackgroundGraphicDefinition.render({
			// @napi-rs/canvas implements the Canvas 2D APIs this renderer uses.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			ctx: ctx as unknown as CanvasRenderingContext2D,
			width: canvas.width,
			height: canvas.height,
			params: {
				preset: "clean",
				presetId: "clean",
				colorA: "#10131f",
				colorB: "#f4f1e8",
				colorC: "#ffffff",
				density: 48,
				intensity: 0,
				scale: 52,
				seed: 3,
			},
		});

		expect(ctx.getImageData(8, 8, 1, 1).data[3]).toBe(255);
	});

	test("uses explicit layout dimensions as its redraw raster size", () => {
		expect(
			presetBackgroundGraphicDefinition.sourceSize?.({
				params: {
					"layout.width": 2048,
					"layout.height": 1152,
				},
			}),
		).toEqual({ width: 2048, height: 1152 });
		expect(presetBackgroundGraphicDefinition.resizeBehavior).toBe("dimensions");
	});

	test("keeps the pattern pixel scale stable as layout dimensions grow", () => {
		expect(
			presetBackgroundGraphicDefinition.sourceSize?.({
				params: {
					"layout.width": 2160,
					"layout.height": 3840,
					"layout.pixelScale": 2,
				},
			}),
		).toEqual({ width: 1080, height: 1920 });
	});

	test("exposes the irregular line texture as an intentional background preset", () => {
		const preset = BACKGROUND_PRESETS.find(
			(candidate) => candidate.id === "textured-grid",
		);

		expect(preset).toBeDefined();
		expect(preset?.params.preset).toBe("textured-grid");
	});
});
