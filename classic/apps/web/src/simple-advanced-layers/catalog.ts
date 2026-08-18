import type { ParamValues } from "@/params";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import {
	PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
	PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
	PERSON_CUTOUT_LAYER_EFFECT_TYPE,
} from "@/simple-advanced-layers/person-cutout-layer";
import type { EffectDragData } from "@/timeline/drag";
import { mediaTimeFromSeconds } from "@/wasm";

export interface SimpleAdvancedLayerPreset {
	id: string;
	name: string;
	description: string;
	effectType: string;
	params: ParamValues;
	defaultDurationSeconds: number;
}

export const SIMPLE_ADVANCED_LAYER_PRESETS: SimpleAdvancedLayerPreset[] = [
	{
		id: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		name: "Speaker Frame Breakout",
		description:
			"Paper-grid speaker stage with a framed base and an applied foreground cutout",
		effectType: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		params: { ...SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS },
		defaultDurationSeconds: SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
	},
	{
		id: "doubleman",
		name: "Doubleman",
		description:
			"Full-size person cutout at the exact spot they appear in the video, transparent everywhere else — put text or graphics behind them",
		effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
		params: { ...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS, backgroundMode: "remove" },
		defaultDurationSeconds: PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
	},
	{
		id: "blur-backdrop",
		name: "Blur Background",
		description:
			"Keeps the person sharp and in place while softly blurring everything behind them",
		effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
		params: { ...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS, backgroundMode: "blur" },
		defaultDurationSeconds: PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
	},
	{
		id: "color-pop-backdrop",
		name: "Color Pop",
		description:
			"Desaturates the background to black & white while the person stays in full color",
		effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
		params: {
			...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
			backgroundMode: "grayscale",
		},
		defaultDurationSeconds: PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
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
			seconds: preset.defaultDurationSeconds,
		}),
	};
}
