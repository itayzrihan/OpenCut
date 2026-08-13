import { describe, expect, test } from "bun:test";
import {
	buildTextAccentOverridePatch,
	supportsTextAccentOverride,
} from "@/components/editor/panels/properties/text-scope";
import type { TextElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTime } from "@/wasm";

function createTextElement(overrides: Partial<TextElement> = {}): TextElement {
	return {
		...DEFAULTS.text.element,
		...overrides,
		id: overrides.id ?? "caption",
		params: {
			...DEFAULTS.text.element.params,
			content: "One Two",
			color: "#111111",
			...(overrides.params ?? {}),
		},
		wordRuns: overrides.wordRuns ?? [
			{
				id: "one",
				text: "One",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 0 }),
				endTime: mediaTime({ ticks: 1 }),
			},
			{
				id: "two",
				text: "Two",
				lineIndex: 1,
				startTime: mediaTime({ ticks: 1 }),
				endTime: mediaTime({ ticks: 2 }),
			},
		],
	};
}

describe("text accent override", () => {
	test("offers the override only for text with caption accent behavior", () => {
		expect(
			supportsTextAccentOverride({
				element: createTextElement({ captionAccentColor: "#ffffff" }),
			}),
		).toBe(true);
		expect(
			supportsTextAccentOverride({
				element: createTextElement({ captionRevealMode: "spoken-word-keep" }),
			}),
		).toBe(true);
		expect(
			supportsTextAccentOverride({
				element: createTextElement(),
			}),
		).toBe(false);
	});

	test("overrides the layer accent without changing the base text color", () => {
		const element = createTextElement({
			captionAccentColor: "#ffffff",
		});

		expect(
			buildTextAccentOverridePatch({
				element,
				scope: { type: "layer" },
				color: "#111111",
			}),
		).toEqual({ captionAccentColor: "#111111" });
		expect(element.params.color).toBe("#111111");
	});

	test("overrides only the selected row accent", () => {
		const element = createTextElement();

		const patch = buildTextAccentOverridePatch({
			element,
			scope: { type: "row", lineIndex: 1 },
			color: "#222222",
		});

		expect(patch.wordRuns).toEqual(element.wordRuns);
		expect(patch.textRowOverrides).toHaveLength(1);
		expect(patch.textRowOverrides?.[0]).toMatchObject({
			lineIndex: 1,
			accentColor: "#222222",
		});
	});

	test("overrides only the selected words and preserves other word settings", () => {
		const element = createTextElement({
			wordRuns: [
				{
					id: "one",
					text: "One",
					lineIndex: 0,
					startTime: mediaTime({ ticks: 0 }),
					endTime: mediaTime({ ticks: 1 }),
					transitionIn: "rise",
				},
				{
					id: "two",
					text: "Two",
					lineIndex: 0,
					startTime: mediaTime({ ticks: 1 }),
					endTime: mediaTime({ ticks: 2 }),
				},
			],
		});

		const patch = buildTextAccentOverridePatch({
			element,
			scope: { type: "words", wordIds: ["one"] },
			color: "#333333",
		});

		expect(patch.wordRuns?.[0]).toMatchObject({
			id: "one",
			transitionIn: "rise",
			accentColor: "#333333",
		});
		expect(patch.wordRuns?.[1]?.accentColor).toBeUndefined();
	});
});
