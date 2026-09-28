import type { EffectDefinition } from "@/effects/types";

// Classic renderer capability; persisted using the existing canonical effect element.
export const colorCorrectionEffectDefinition: EffectDefinition = {
	type: "color-correction",
	name: "Color Correction",
	keywords: ["exposure", "white balance", "temperature", "brightness"],
	params: [
		{ key: "exposure", label: "Exposure", type: "number", default: 0, min: -2, max: 2, step: 0.05 },
		{ key: "temperature", label: "Temperature", type: "number", default: 0, min: -100, max: 100, step: 1 },
		{ key: "tint", label: "Tint", type: "number", default: 0, min: -100, max: 100, step: 1 },
		{ key: "saturation", label: "Saturation", type: "number", default: 100, min: 0, max: 200, step: 1 },
	],
	renderer: {
		passes: [{ shader: "color-correction", uniforms: ({ effectParams }) => ({
			u_exposure: Number(effectParams.exposure ?? 0),
			u_temperature: Number(effectParams.temperature ?? 0) / 100,
			u_tint: Number(effectParams.tint ?? 0) / 100,
			u_saturation: Number(effectParams.saturation ?? 100) / 100,
		}) }],
	},
};
