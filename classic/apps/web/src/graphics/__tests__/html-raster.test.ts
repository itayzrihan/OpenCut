import { describe, expect, test } from "bun:test";
import { getHyperframeTimeSeconds } from "../definitions/hyperframe";
import { applyHyperframeInlineSeekDelays } from "../html-raster";

describe("applyHyperframeInlineSeekDelays", () => {
	test("converts the renderer media-tick clock to CSS seconds", () => {
		expect(getHyperframeTimeSeconds({ mediaTicks: 12_000 })).toBe(0.1);
		expect(getHyperframeTimeSeconds({ mediaTicks: 392_400 })).toBe(3.27);
	});

	test("converts each sanctioned delay into a seeked inline animation delay", () => {
		const result = applyHyperframeInlineSeekDelays({
			body: [
				'<span style="color:red;--hf-delay:.23s">one</span>',
				'<span style="--hf-delay:calc(var(--i) * 120ms);opacity:1">two</span>',
			].join(""),
			timeSeconds: 0.1,
		});

		expect(result).toContain(
			"animation-delay:calc(.23s - 0.1s)!important",
		);
		expect(result).toContain("visibility:hidden!important");
		expect(result).toContain(
			"animation-delay:calc(calc(var(--i) * 120ms) - 0.1s)!important",
		);
	});

	test("does not hide an element once its numeric cue has started", () => {
		const result = applyHyperframeInlineSeekDelays({
			body: '<span style="--hf-delay:230ms">one</span>',
			timeSeconds: 0.23,
		});

		expect(result).not.toContain("visibility:hidden");
	});

	test("leaves markup without a hyperframe delay unchanged", () => {
		const body = '<span style="opacity:1">always visible</span>';
		expect(
			applyHyperframeInlineSeekDelays({ body, timeSeconds: 1 }),
		).toBe(body);
	});
});
