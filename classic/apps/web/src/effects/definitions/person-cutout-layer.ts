import type { EffectDefinition } from "@/effects/types";
import type { ParamDefinition, ParamValue } from "@/params";
import {
	PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
	PERSON_CUTOUT_LAYER_EFFECT_TYPE,
} from "@/simple-advanced-layers/person-cutout-layer";

export { PERSON_CUTOUT_LAYER_EFFECT_TYPE };

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

export const personCutoutLayerEffectDefinition: EffectDefinition = {
	type: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
	name: "Person Cutout Layer",
	keywords: [
		"person",
		"cutout",
		"doubleman",
		"blur background",
		"color pop",
		"smart layer",
	],
	params: Object.entries(PERSON_CUTOUT_LAYER_DEFAULT_PARAMS).map(
		([key, defaultValue]) => buildParamDefinition({ key, defaultValue }),
	),
	renderer: {
		// This smart layer resolves as an atomic composition in the scene renderer.
		// It deliberately has no generic post-processing passes.
		passes: [],
	},
};
