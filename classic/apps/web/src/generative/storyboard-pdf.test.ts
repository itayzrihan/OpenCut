import { expect, test } from "bun:test";
import { parseStoryboardPdfPlan } from "./storyboard-pdf-plan";
import { encodeStoryboardPdf } from "./storyboard-pdf-writer";
import { textDirection, wrapCanvasText } from "./storyboard-pdf-render";
const plan = {
	projectId: "project",
	revision: 7,
	title: "Client proposal",
	summary: "",
	sheets: [],
	scenes: [
		{
			id: "scene",
			title: "Scene",
			description: "A door opens.",
			startSeconds: 0,
			endSeconds: 4,
			imageReferenceId: null,
		},
	],
	sceneImages: [],
	digest: "a".repeat(64),
};
test("PDF host rejects unknown fields, arbitrary URLs, missing images and incomplete timing", () => {
	expect(parseStoryboardPdfPlan(plan)).toEqual(plan);
	expect(
		parseStoryboardPdfPlan({ ...plan, title: "🎬".repeat(200) }).title,
	).toBe("🎬".repeat(200));
	expect(() =>
		parseStoryboardPdfPlan({ ...plan, title: "🎬".repeat(201) }),
	).toThrow();
	for (const value of [
		{ ...plan, storyboard_prompt: "private" },
		{
			...plan,
			scenes: [{ ...plan.scenes[0], imageReferenceId: "b".repeat(32) }],
		},
		{
			...plan,
			scenes: [
				{ ...plan.scenes[0], imageReferenceId: "https://example.com/image" },
			],
		},
		{ ...plan, scenes: [{ ...plan.scenes[0], startSeconds: null }] },
		{ ...plan, scenes: [{ ...plan.scenes[0], endSeconds: 0 }] },
	])
		expect(() => parseStoryboardPdfPlan(value)).toThrow();
});
test("PDF binary container has exact xref offsets, bounded pages and no executable syntax", () => {
	const jpeg = new Uint8Array([255, 216, 255, 226, 0, 0, 255, 217]);
	const bytes = encodeStoryboardPdf([
		{ bytes: jpeg, width: 1600, height: 2263 },
		{ bytes: jpeg, width: 1600, height: 2263 },
	]);
	const ascii = new TextDecoder("latin1").decode(bytes);
	const xref = Number(ascii.match(/startxref\n(\d+)/)?.[1]);
	expect(new TextDecoder().decode(bytes.subarray(xref, xref + 4))).toBe("xref");
	for (const [i, line] of ascii
		.slice(ascii.indexOf("0000000000 65535 f") + 20)
		.split("\n")
		.entries()) {
		if (!/^\d{10} 00000 n /.test(line)) break;
		const start = Number(line.slice(0, 10));
		expect(new TextDecoder().decode(bytes.subarray(start, start + 7))).toBe(
			`${i + 1} 0 obj`,
		);
	}
	expect(ascii).toContain("/Count 2");
	expect(ascii.endsWith("%%EOF\n")).toBe(true);
	expect(ascii).not.toContain("/JavaScript");
	expect(() => encodeStoryboardPdf([])).toThrow();
	expect(() =>
		encodeStoryboardPdf(Array(121).fill({ bytes: jpeg, width: 1, height: 1 })),
	).toThrow();
	expect(() =>
		encodeStoryboardPdf([{ bytes: new Uint8Array(4), width: 1, height: 1 }]),
	).toThrow();
});
test("multilingual wrapping preserves complete text and breaks oversized tokens", () => {
	const measureText = (text: string) => ({
		width: Array.from(text).length * 10,
	});
	const text = "שלום עולם, this is a long proposal.\nABCDEFGHIJKLMN";
	const lines = wrapCanvasText({
		ctx: { measureText },
		text: text,
		width: 80,
	});
	expect(lines.every((line) => measureText(line).width <= 80)).toBe(true);
	expect(lines.join("").replaceAll(" ", "")).toBe(text.replaceAll(/\s/g, ""));
	expect(textDirection("(שלום) POCUT 2026")).toBe("rtl");
	expect(textDirection("Welcome שלום")).toBe("ltr");
});
