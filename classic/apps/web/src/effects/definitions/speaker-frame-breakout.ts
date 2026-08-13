import type { EffectDefinition } from "@/effects/types";
import type { ParamDefinition, ParamValue } from "@/params";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
} from "@/simple-advanced-layers/speaker-frame-breakout";

export { SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE };

function labelFromKey({ key }: { key: string }): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/^./, (value) => value.toUpperCase());
}

function buildParamDefinition({
	key,
	defaultValue,
}: {
	key: string;
	defaultValue: ParamValue;
}): ParamDefinition {
	const label = labelFromKey({ key });
	if (typeof defaultValue === "boolean") {
		return {
			key,
			label,
			type: "boolean",
			default: defaultValue,
			keyframable: false,
		};
	}
	if (typeof defaultValue === "number") {
		return {
			key,
			label,
			type: "number",
			default: defaultValue,
			min: -100_000,
			max: 100_000,
			step: Number.isInteger(defaultValue) ? 1 : 0.01,
			keyframable: false,
		};
	}
	if (key.toLowerCase().includes("color")) {
		return {
			key,
			label,
			type: "color",
			default: defaultValue,
			keyframable: false,
		};
	}
	return {
		key,
		label,
		type: "text",
		default: defaultValue,
		keyframable: false,
	};
}

export const speakerFrameBreakoutEffectDefinition: EffectDefinition = {
	type: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
	name: "Speaker Frame Breakout",
	keywords: [
		"speaker",
		"frame",
		"breakout",
		"cutout",
		"paper grid",
		"smart layer",
	],
	params: Object.entries(SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS).map(
		([key, defaultValue]) => buildParamDefinition({ key, defaultValue }),
	),
	renderer: {
		// This smart layer resolves as an atomic composition in the scene renderer.
		// It deliberately has no generic post-processing passes.
		passes: [],
	},
};
