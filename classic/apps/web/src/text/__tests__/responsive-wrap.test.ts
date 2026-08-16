import { describe, expect, test } from "bun:test";
import type { TextLayoutMeasurementContext } from "@/text/layout";
import {
	buildAutoFitTextPatch,
	reflowResponsiveTextElement,
	wrapTextToWidth,
} from "@/text/responsive-wrap";
import type { TextElement } from "@/timeline/types";

function createContext(): TextLayoutMeasurementContext {
	return {
		font: "10px Arial",
		textBaseline: "middle",
		letterSpacing: "0px",
		save() {},
		restore() {},
		measureText(text: string) {
			const fontSize = Number.parseFloat(
				this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "10",
			);
			return { width: text.length * fontSize } as TextMetrics;
		},
	};
}

function createElement(content = "one two\nthree four"): TextElement {
	return {
		id: "caption-1",
		name: "Caption",
		type: "text",
		duration: 10 as TextElement["duration"],
		startTime: 0 as TextElement["startTime"],
		trimStart: 0 as TextElement["trimStart"],
		trimEnd: 0 as TextElement["trimEnd"],
		params: { content, fontSize: 3 },
		responsiveText: {
			sourceContent: "one two three four",
			generatedContent: "one two\nthree four",
			maxWidth: 100,
			canvasHeight: 100,
			fontSize: 3,
		},
		wordRuns: ["one", "two", "three", "four"].map((text, index) => ({
			id: `word-${index}`,
			text,
			lineIndex: index < 2 ? 0 : 1,
		})),
	};
}

describe("responsive caption wrapping", () => {
	test("wraps text to the measured width", () => {
		const ctx = createContext();
		ctx.font = "10px Arial";
		expect(wrapTextToWidth({ ctx, text: "one two three", maxWidth: 75 })).toBe(
			"one two\nthree",
		);
	});

	test("reflows generated caption lines after a font-size change", () => {
		const result = reflowResponsiveTextElement({
			element: createElement(),
			text: {
				content: "one two\nthree four",
				fontSize: 1,
				fontFamily: "Arial",
				fontWeight: "normal",
				fontStyle: "normal",
				textAlign: "center",
			},
			canvasHeight: 100,
			ctx: createContext(),
		});

		expect(result?.text.content).toBe("one two three four");
		expect(result?.element.wordRuns?.map((word) => word.lineIndex)).toEqual([
			0, 0, 0, 0,
		]);
	});

	test("preserves content that was edited manually", () => {
		const result = reflowResponsiveTextElement({
			element: createElement("one\ntwo three four"),
			text: {
				content: "one\ntwo three four",
				fontSize: 1,
				fontFamily: "Arial",
				fontWeight: "normal",
				fontStyle: "normal",
				textAlign: "center",
			},
			canvasHeight: 100,
			ctx: createContext(),
		});

		expect(result).toBeNull();
	});

	test("explicitly auto-fits manually edited content and restores responsiveness", () => {
		const element = createElement("one\ntwo three four");
		const patch = buildAutoFitTextPatch({
			element,
			text: {
				content: "one\ntwo three four",
				fontSize: 1,
				fontFamily: "Arial",
				fontWeight: "normal",
				fontStyle: "normal",
				textAlign: "center",
			},
			canvasHeight: 100,
			maxWidth: 100,
			ctx: createContext(),
		});

		expect(patch.params.content).toBe("one two three four");
		expect(patch.wordRuns?.map((word) => word.lineIndex)).toEqual([0, 0, 0, 0]);
		expect(patch.responsiveText).toMatchObject({
			sourceContent: "one two three four",
			generatedContent: "one two three four",
			maxWidth: 100,
			canvasHeight: 100,
			fontSize: 1,
		});
	});
});
