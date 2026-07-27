import { describe, expect, test } from "bun:test";
import { parseTypekitFontsFromCss } from "@/fonts/typekit-fonts";

describe("Typekit font parsing", () => {
	test("extracts families, styles, and weights from font-face blocks", () => {
		const fonts = parseTypekitFontsFromCss({
			css: `
				@font-face {
					font-family:"liebling";
					font-display:auto;
					font-style:normal;
					font-weight:900;
				}

				@font-face {
					font-family:"liebling";
					font-style:normal;
					font-weight:400;
				}

				@font-face {
					font-family:"adapter-hebrew-text";
					font-style:italic;
					font-weight:bold;
				}
			`,
		});

		expect(fonts).toEqual([
			{
				family: "adapter-hebrew-text",
				styles: ["italic"],
				variants: [{ style: "italic", weight: 700 }],
				weights: [700],
			},
			{
				family: "liebling",
				styles: ["normal"],
				variants: [
					{ style: "normal", weight: 400 },
					{ style: "normal", weight: 900 },
				],
				weights: [400, 900],
			},
		]);
	});

	test("keeps the preferred WOFF2 source for explicit FontFace loading", () => {
		const [font] = parseTypekitFontsFromCss({
			css: `
				@font-face {
					font-family: "liebling";
					font-style: normal;
					font-weight: 400;
					src: url("https://example.com/font.woff") format("woff"),
						url("https://example.com/font.woff2") format("woff2");
				}
			`,
		});
		expect(font?.variants[0]?.sourceUrl).toBe(
			"https://example.com/font.woff2",
		);
	});
});
