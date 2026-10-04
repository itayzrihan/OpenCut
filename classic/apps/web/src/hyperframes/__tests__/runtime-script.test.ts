import { expect, mock, test } from "bun:test";
import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";

const published = getHyperframeRuntimeScript();
let fixture = published;
mock.module("@hyperframes/core/runtime-script", () => ({
	getHyperframeRuntimeScript: () => fixture,
}));
const { getOpenCutHyperframesRuntimeScript } =
	await import("../runtime-script");

test("the pinned media correction refuses a changed or ambiguous runtime", () => {
	try {
		expect(getOpenCutHyperframesRuntimeScript()).not.toBe(published);
		for (const unsupported of [
			"",
			"new runtime without the pinned statement",
			published + published,
		]) {
			fixture = unsupported;
			expect(() => getOpenCutHyperframesRuntimeScript()).toThrow(
				"paused-video sync contract changed",
			);
		}
	} finally {
		fixture = published;
	}
});
