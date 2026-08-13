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
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import { mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";

describe("simple advanced layers catalog", () => {
	test("places the tab exactly between UI Elements and Backgrounds", () => {
		const uiElementsIndex = TAB_KEYS.indexOf("ui-elements");

		expect(TAB_KEYS[uiElementsIndex + 1]).toBe("simple-advanced-layers");
		expect(TAB_KEYS[uiElementsIndex + 2]).toBe("backgrounds");
		expect(tabs["simple-advanced-layers"].label).toBe("simple advanced layers");
	});

	test("publishes one smart Speaker Frame Breakout draggable", () => {
		expect(SIMPLE_ADVANCED_LAYER_PRESETS).toHaveLength(1);

		const preset = SIMPLE_ADVANCED_LAYER_PRESETS[0];
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
