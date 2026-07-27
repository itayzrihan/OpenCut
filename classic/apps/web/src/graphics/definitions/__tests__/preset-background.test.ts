import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
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
});
