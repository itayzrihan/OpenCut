import type { EffectDefinition } from "@/effects/types";
import { parseColorToLinearRgba, type ParamValues } from "@/params";

export const EDITORIAL_EDGE_FEATHER_EFFECT_TYPE = "editorial-edge-feather";

function numberParam({
	params,
	key,
	fallback,
	min,
	max,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
	min: number;
	max: number;
}): number {
	const raw = params[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function colorParam({ params }: { params: ParamValues }): number[] {
	const raw = params.color;
	const parsed = parseColorToLinearRgba({
		color: typeof raw === "string" ? raw : "#000000",
	});
	return parsed ? [parsed.r, parsed.g, parsed.b, parsed.a] : [0, 0, 0, 1];
}

export const editorialEdgeFeatherEffectDefinition: EffectDefinition = {
	type: EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
	name: "Editorial Edge Feather",
	keywords: [
		"edge feather",
		"top bottom fade",
		"inner shadow",
		"caption contrast",
		"talking head",
	],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 38,
			min: 0,
			max: 100,
			step: 1,
			unit: "percent",
		},
		{
			key: "height",
			label: "Height",
			type: "number",
			default: 20,
			min: 1,
			max: 50,
			step: 1,
			unit: "percent",
		},
		{
			key: "softness",
			label: "Softness",
			type: "number",
			default: 78,
			min: 0,
			max: 100,
			step: 1,
			unit: "percent",
		},
		{
			key: "color",
			label: "Color",
			type: "color",
			default: "#000000",
		},
	],
	renderer: {
		passes: [
			{
				shader: EDITORIAL_EDGE_FEATHER_EFFECT_TYPE,
				uniforms: ({ effectParams }) => ({
					u_intensity:
						numberParam({
							params: effectParams,
							key: "intensity",
							fallback: 38,
							min: 0,
							max: 100,
						}) / 100,
					u_height:
						numberParam({
							params: effectParams,
							key: "height",
							fallback: 20,
							min: 1,
							max: 50,
						}) / 100,
					u_softness:
						numberParam({
							params: effectParams,
							key: "softness",
							fallback: 78,
							min: 0,
							max: 100,
						}) / 100,
					u_color: colorParam({ params: effectParams }),
				}),
			},
		],
	},
};
