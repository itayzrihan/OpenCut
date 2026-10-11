import type { EffectDefinition } from "@/effects/types";
import { buildGaussianBlurPasses } from "./blur";

/** Native, editable directional softness; not Adobe's proprietary Impact kernel. */
export const directionalBlurEffectDefinition: EffectDefinition = {
	type: "directional-blur",
	name: "Directional Blur",
	keywords: ["blur", "direction", "motion"],
	params: [
		{
			key: "amount",
			label: "Amount",
			type: "number",
			default: 13,
			min: 0,
			max: 100,
			step: 0.1,
		},
		{
			key: "angle",
			label: "Angle",
			type: "number",
			default: 0,
			min: -360,
			max: 360,
			step: 0.1,
		},
	],
	renderer: {
		passes: [],
		buildPasses: ({ effectParams, width }) => {
			const amount = Number(effectParams.amount ?? 0);
			const angle = Number(effectParams.angle ?? 0);
			if (!Number.isFinite(amount) || !Number.isFinite(angle) || amount <= 0)
				return [];
			const radians = (angle * Math.PI) / 180;
			return buildGaussianBlurPasses({
				sigmaX: (amount * width) / 1920,
				sigmaY: 0,
			})
				.filter((_, index) => index % 2 === 0)
				.map((pass) => ({
					...pass,
					uniforms: {
						...pass.uniforms,
						u_direction: [Math.cos(radians), Math.sin(radians)],
					},
				}));
		},
	},
};
