import { describe, expect, test } from "bun:test";
import {
	TAB_KEYS,
	tabs,
} from "@/components/editor/panels/assets/assets-panel-store";
import {
	buildSimpleAdvancedLayerDragData,
	SIMPLE_ADVANCED_LAYER_PRESETS,
} from "@/simple-advanced-layers/catalog";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import { PERSON_CUTOUT_LAYER_EFFECT_TYPE } from "@/simple-advanced-layers/person-cutout-layer";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import { mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";

describe("simple advanced layers catalog", () => {
	test("places the tab exactly between UI Elements and Backgrounds", () => {
		const uiElementsIndex = TAB_KEYS.indexOf("ui-elements");

		expect(TAB_KEYS[uiElementsIndex + 1]).toBe("simple-advanced-layers");
		expect(TAB_KEYS[uiElementsIndex + 2]).toBe("backgrounds");
		expect(tabs["simple-advanced-layers"].label).toBe("simple advanced layers");
	});

	test("publishes four smart layer draggables", () => {
		expect(SIMPLE_ADVANCED_LAYER_PRESETS).toHaveLength(4);
	});

	test("publishes the Speaker Frame Breakout draggable", () => {
		const preset = SIMPLE_ADVANCED_LAYER_PRESETS.find(
			(entry) => entry.id === SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		);
		expect(preset?.effectType).toBe(SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE);

		const dragData = buildSimpleAdvancedLayerDragData({ preset: preset! });
		expect(dragData).toMatchObject({
			id: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
			name: "Speaker Frame Breakout",
			type: "effect",
			effectType: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
			targetElementTypes: ["video"],
			placement: "layer-above-target",
			params: SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
		});
		expect(dragData.params).not.toBe(SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS);
		expect(dragData.params).toMatchObject({
			backgroundPresetId: "paper-grid",
			matteApplied: false,
			fadeInDuration: 0.35,
			fadeOutDuration: 0.35,
		});
		expect(
			mediaTimeToSeconds({
				time: dragData.duration ?? ZERO_MEDIA_TIME,
			}),
		).toBe(6);
	});

	test.each([
		["doubleman", "Doubleman", "remove"],
		["blur-backdrop", "Blur Background", "blur"],
		["color-pop-backdrop", "Color Pop", "grayscale"],
	])(
		"publishes the %s person-cutout-layer draggable",
		(id, name, backgroundMode) => {
			const preset = SIMPLE_ADVANCED_LAYER_PRESETS.find(
				(entry) => entry.id === id,
			);
			expect(preset?.effectType).toBe(PERSON_CUTOUT_LAYER_EFFECT_TYPE);

			const dragData = buildSimpleAdvancedLayerDragData({ preset: preset! });
			expect(dragData).toMatchObject({
				id,
				name,
				type: "effect",
				effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
				targetElementTypes: ["video"],
				placement: "layer-above-target",
			});
			expect(dragData.params).toMatchObject({
				backgroundMode,
				matteApplied: false,
				fadeInDuration: 0.35,
				fadeOutDuration: 0.35,
			});
			expect(
				mediaTimeToSeconds({
					time: dragData.duration ?? ZERO_MEDIA_TIME,
				}),
			).toBe(6);
		},
	);

	test("keeps Paper Grid available in the shared Backgrounds catalog", () => {
		expect(
			BACKGROUND_PRESETS.find((preset) => preset.id === "paper-grid"),
		).toMatchObject({
			name: "Paper Grid",
			params: {
				preset: "grid",
				colorA: "#F8F8F5",
				colorB: "#D8DAD5",
				density: 48,
			},
		});
	});
});
