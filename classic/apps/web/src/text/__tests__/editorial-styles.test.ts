import { describe, expect, test } from "bun:test";
import {
	EDITORIAL_TEXT_STYLES,
	findEditorialTextStyle,
} from "@/text/editorial-styles";

describe("editorial text styles", () => {
	test("provides adaptive light and dark presets with a soft lower feather", () => {
		expect(EDITORIAL_TEXT_STYLES.map((style) => style.id)).toEqual([
			"editorial-feather-white",
			"editorial-feather-black",
		]);

		for (const style of EDITORIAL_TEXT_STYLES) {
			expect(style.params["shadow.enabled"]).toBe(true);
			expect(style.params["shadow.blur"]).toBeGreaterThanOrEqual(14);
			expect(style.params["shadow.offsetY"]).toBeGreaterThan(0);
			expect(style.params["stroke.enabled"]).toBe(false);
		}
	});

	test("selects the white style for footage and black style for light stages", () => {
		expect(
			findEditorialTextStyle({ id: "editorial-feather-white" })?.params.color,
		).toBe("#ffffff");
		expect(
			findEditorialTextStyle({ id: "editorial-feather-black" })?.params.color,
		).toBe("#111111");
	});
});
