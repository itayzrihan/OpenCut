import type { ParamValues } from "@/params";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import type { EffectDragData } from "@/timeline/drag";
import { mediaTimeFromSeconds } from "@/wasm";

export interface SimpleAdvancedLayerPreset {
	id: string;
	name: string;
	description: string;
	effectType: string;
	params: ParamValues;
}

export const SIMPLE_ADVANCED_LAYER_PRESETS: SimpleAdvancedLayerPreset[] = [
	{
		id: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		name: "Speaker Frame Breakout",
		description:
			"Paper-grid speaker stage with a framed base and an applied foreground cutout",
		effectType: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		params: { ...SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS },
	},
];

export function buildSimpleAdvancedLayerDragData({
	preset,
}: {
	preset: SimpleAdvancedLayerPreset;
}): EffectDragData {
	return {
		id: preset.id,
		name: preset.name,
		type: "effect",
		effectType: preset.effectType,
		params: { ...preset.params },
		targetElementTypes: ["video"],
		placement: "layer-above-target",
		duration: mediaTimeFromSeconds({
			seconds: SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
		}),
	};
}
