import type { EffectDefinition } from "@/effects/types";

export const sharpenEffectDefinition: EffectDefinition = {
	type: "sharpen",
	name: "Sharpen",
	keywords: ["sharpen", "sharp", "detail", "crisp", "חידוד"],
	params: [
		{
			key: "intensity",
			label: "Amount",
			type: "number",
			default: 15,
			min: 0,
			max: 100,
			step: 1,
			unit: "percent",
		},
	],
	renderer: {
		passes: [
			{
				shader: "sharpen",
				uniforms: ({ effectParams }) => ({
					u_intensity:
						Math.max(
							0,
							Math.min(
								100,
								typeof effectParams.intensity === "number" &&
									Number.isFinite(effectParams.intensity)
									? effectParams.intensity
									: 15,
							),
						) / 100,
				}),
			},
		],
	},
};
