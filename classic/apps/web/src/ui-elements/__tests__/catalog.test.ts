import { describe, expect, test } from "bun:test";
import { createCanvas, Path2D as NativePath2D } from "@napi-rs/canvas";
import { uiElementGraphicDefinition } from "@/graphics/definitions/ui-element";
import {
	getUiElementAnimationOptions,
	UI_ELEMENT_TEMPLATE_OPTIONS,
} from "@/ui-elements/animation-options";
import { UI_ELEMENT_PRESETS } from "@/ui-elements/catalog";

const PRODUCT_PRESET_IDS = [
	"product-note",
	"product-search",
	"product-goal",
	"product-earnings",
	"product-followers",
	"product-folder",
	"product-message-left",
	"product-message-right",
	"product-team",
	"product-notification",
	"editorial-feature-checklist",
	"editorial-reject-task",
	"editorial-comment-reply",
] as const;

Object.assign(globalThis, { Path2D: NativePath2D });

describe("minimal product UI asset catalog", () => {
	test("keeps every learned asset editable, searchable, timed, and animated", () => {
		const templates = new Set(
			UI_ELEMENT_TEMPLATE_OPTIONS.map((option) => option.value),
		);

		for (const id of PRODUCT_PRESET_IDS) {
			const preset = UI_ELEMENT_PRESETS.find(
				(candidate) => candidate.id === id,
			);
			expect(preset, id).toBeDefined();
			if (!preset) continue;

			const template = String(preset.params.template);
			const animationIn = String(preset.params.animationIn);
			const animationOut = String(preset.params.animationOut);
			expect(templates.has(template), `${id} template`).toBe(true);
			expect(preset.category.length, `${id} category`).toBeGreaterThan(0);
			expect(preset.keywords.length, `${id} keywords`).toBeGreaterThanOrEqual(
				3,
			);
			expect(preset.whenToUse.length, `${id} usage`).toBeGreaterThan(0);
			expect(
				preset.defaultDurationSeconds,
				`${id} duration`,
			).toBeGreaterThanOrEqual(2);
			expect(animationIn, `${id} entrance`).not.toBe("auto");
			expect(animationOut, `${id} exit`).not.toBe("auto");
			expect(
				getUiElementAnimationOptions({ template, side: "in" }).some(
					(option) => option.value === animationIn,
				),
				`${id} compatible entrance`,
			).toBe(true);
			expect(
				getUiElementAnimationOptions({ template, side: "out" }).some(
					(option) => option.value === animationOut,
				),
				`${id} compatible exit`,
			).toBe(true);
			expect(Number(preset.params.animationInEnd)).toBeLessThan(
				Number(preset.params.eventAt),
			);
			expect(Number(preset.params.eventAt)).toBeLessThan(
				Number(preset.params.animationOutStart),
			);
		}
	});

	test("does not duplicate preset identifiers", () => {
		const ids = UI_ELEMENT_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("renders every learned asset at its readable resting state", () => {
		for (const id of PRODUCT_PRESET_IDS) {
			const preset = UI_ELEMENT_PRESETS.find(
				(candidate) => candidate.id === id,
			);
			if (!preset) throw new Error(`Missing product UI preset ${id}`);
			const canvas = createCanvas(480, 270);
			const ctx = canvas.getContext("2d");

			uiElementGraphicDefinition.render({
				// @napi-rs/canvas implements the Canvas 2D APIs used by the renderer.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
				ctx: ctx as unknown as CanvasRenderingContext2D,
				params: preset.params,
				width: canvas.width,
				height: canvas.height,
				localTime: preset.defaultDurationSeconds * 0.6,
				duration: preset.defaultDurationSeconds,
			});

			const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			let paintedPixels = 0;
			for (let index = 3; index < pixels.length; index += 4) {
				if ((pixels[index] ?? 0) > 0) paintedPixels += 1;
			}
			expect(paintedPixels, `${id} painted pixels`).toBeGreaterThan(500);
		}
	});
});
