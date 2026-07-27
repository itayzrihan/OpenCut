import { describe, expect, test } from "bun:test";
import { getCreativePlanQualityNotes } from "@/ai/creative-plan-quality";
import type { AiEditOperation } from "@/ai/types";
import type { MediaTime } from "@/wasm";

const t = (ticks: number) => {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tests use valid integer media ticks.
	return ticks as MediaTime;
};

describe("creative plan quality", () => {
	test("flags an under-resolved broad creative treatment", () => {
		const notes = getCreativePlanQualityNotes({
			title: "Make this amazing and cinematic",
			summary: "Add one zoom",
			operations: [
				{
					type: "upsert_keyframe",
					trackId: "video",
					elementId: "clip",
					propertyPath: "transform.scaleX",
					time: t(0),
					value: 1.1,
				},
			],
		});

		expect(notes.join("\n")).toContain(
			"broad creative treatment is unusually minimal",
		);
	});

	test("treats explicitly requested SFX and VFX as required coverage", () => {
		const notes = getCreativePlanQualityNotes({
			title: "Cinematic VFX and SFX pass",
			summary: "Use visual effects and sound design on the hero beat",
			operations: [
				{
					type: "apply_transition",
					trackId: "video",
					elementId: "clip",
					presetId: "fade",
					side: "in",
				},
			],
		});

		expect(notes.join("\n")).toContain("calls for SFX or sound design");
		expect(notes.join("\n")).toContain("calls for VFX");
	});

	test("recognizes supported SFX and VFX operations", () => {
		const notes = getCreativePlanQualityNotes({
			title: "Cinematic VFX and SFX pass",
			summary: "Accent the observed impact with a flash and exact whoosh",
			operations: [
				{
					type: "insert_effect_element",
					effectType: "flash",
					startTime: t(120_000),
					duration: t(30_000),
				},
				{
					type: "insert_library_audio_element",
					libraryAssetId: "audio-whoosh",
					name: "Short whoosh",
					startTime: t(120_000),
					duration: t(60_000),
				},
			],
		});

		expect(notes).toEqual([]);
	});

	test("flags a broad plan that repeats only one creative dimension", () => {
		const operations: AiEditOperation[] = Array.from(
			{ length: 6 },
			(_, index) => ({
				type: "insert_text_element",
				content: `Title ${index + 1}`,
				startTime: t(index * 120_000),
				duration: t(60_000),
			}),
		);
		const notes = getCreativePlanQualityNotes({
			title: "Epic trailer treatment",
			summary: "Make every beat epic",
			operations,
		});

		expect(notes.join("\n")).toContain("broad treatment is single-dimensional");
	});

	test("retains repetition warnings for mechanically duplicated transitions", () => {
		const operations: AiEditOperation[] = Array.from(
			{ length: 8 },
			(_, index) => ({
				type: "apply_transition",
				trackId: "video",
				elementId: `clip-${index + 1}`,
				presetId: "fade",
				side: "in",
			}),
		);
		const notes = getCreativePlanQualityNotes({ operations });

		expect(notes.join("\n")).toContain("one operation type dominates");
		expect(notes.join("\n")).toContain(
			"transition operations repeat the same preset and side",
		);
	});

	test("does not impose a creative quota on an ordinary focused edit", () => {
		const notes = getCreativePlanQualityNotes({
			title: "Fix the typo",
			summary: "Correct one title",
			operations: [
				{
					type: "update_element",
					trackId: "titles",
					elementId: "title-1",
					patch: { name: "Correct title" },
				},
			],
		});

		expect(notes).toEqual([]);
	});
});
