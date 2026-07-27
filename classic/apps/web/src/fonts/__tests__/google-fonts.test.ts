import { describe, expect, test } from "bun:test";
import { parseGoogleFontAtlasStyles } from "@/fonts/google-fonts";

describe("Google font atlas styles", () => {
	test("extracts exact normal and italic variants", () => {
		expect(
			parseGoogleFontAtlasStyles({
				styles: ["400", "700i", "300", "400i", "bad"],
			}),
		).toEqual([
			{ style: "normal", weight: 300 },
			{ style: "italic", weight: 400 },
			{ style: "normal", weight: 400 },
			{ style: "italic", weight: 700 },
		]);
	});
});
