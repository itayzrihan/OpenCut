import { expect, test } from "bun:test";
import { getHyperframesPreviewScale } from "../preview-scale";

test("preview sampling covers portrait fit, viewport density, flips and magnification", () => {
	const input = {
		sourceWidth: 1080,
		sourceHeight: 1920,
		logicalWidth: 1920,
		logicalHeight: 1080,
		outputWidth: 960,
		outputHeight: 540,
		scaleX: 1,
		scaleY: 1,
	};
	expect(getHyperframesPreviewScale(input)).toBe(0.5);
	expect(
		getHyperframesPreviewScale({
			...input,
			outputWidth: 640,
			outputHeight: 360,
		}),
	).toBe(0.25);
	expect(
		getHyperframesPreviewScale({ ...input, scaleX: -2, scaleY: 0.5 }),
	).toBe(1);
	expect(getHyperframesPreviewScale({ ...input, scaleX: 0, scaleY: 0 })).toBe(
		0.125,
	);
	expect(
		getHyperframesPreviewScale({ ...input, preserveFullResolution: true }),
	).toBe(1);
	expect(
		getHyperframesPreviewScale({ ...input, outputWidth: Number.NaN }),
	).toBe(1);
});
