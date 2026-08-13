import { describe, expect, test } from "bun:test";
import { getPreviewRenderSize } from "../render-size";

describe("getPreviewRenderSize", () => {
	test("renders a large parallax world near its displayed pixel size", () => {
		expect(
			getPreviewRenderSize({
				logicalWidth: 5760,
				logicalHeight: 1920,
				viewportWidth: 900,
				viewportHeight: 500,
				devicePixelRatio: 1.5,
			}),
		).toEqual({ width: 1350, height: 450, scale: 0.234375 });
	});

	test("never renders above the logical project resolution", () => {
		expect(
			getPreviewRenderSize({
				logicalWidth: 640,
				logicalHeight: 360,
				viewportWidth: 1920,
				viewportHeight: 1080,
				devicePixelRatio: 2,
			}),
		).toEqual({ width: 640, height: 360, scale: 1 });
	});

	test("caps very large previews", () => {
		const result = getPreviewRenderSize({
			logicalWidth: 3840,
			logicalHeight: 2160,
			viewportWidth: 3840,
			viewportHeight: 2160,
			devicePixelRatio: 2,
		});

		expect(result.width).toBe(1600);
		expect(result.height).toBe(900);
	});
});
