import { sampleAutomaticZoom } from "opencut-wasm";
import type { EffectDefinition } from "@/effects/types";

export const automaticZoomEffectDefinition: EffectDefinition = {
	type: "automatic-zoom",
	name: "Automatic Zoom",
	keywords: ["zoom", "snap", "push in", "pull out"],
	params: [
		{
			key: "style",
			label: "Style",
			type: "select",
			default: "smooth",
			options: [
				{ value: "jump-cut", label: "Jump Cut" },
				{ value: "smooth", label: "Smooth" },
				{ value: "snap-in", label: "Snap In" },
				{ value: "zoom-out", label: "Zoom Out" },
			],
		},
		{
			key: "scale",
			label: "Zoom",
			type: "number",
			default: 1.16,
			min: 1,
			max: 1.3,
			step: 0.01,
		},
		{
			key: "attack",
			label: "Zoom in duration",
			type: "number",
			default: 0.5,
			min: 0.01,
			max: 1.2,
			step: 0.01,
		},
		{
			key: "release",
			label: "Zoom out duration",
			type: "number",
			default: 0.5,
			min: 0.01,
			max: 1.2,
			step: 0.01,
		},
		{
			key: "anchorX",
			label: "Anchor X",
			type: "number",
			default: 0.5,
			min: 0,
			max: 1,
			step: 0.01,
		},
		{
			key: "anchorY",
			label: "Anchor Y",
			type: "number",
			default: 0.4,
			min: 0,
			max: 1,
			step: 0.01,
		},
	],
	renderer: {
		passes: [
			{
				shader: "automatic-zoom",
				uniforms: ({ effectParams: p, localTime = 0 }) => ({
					u_scale: sampleAutomaticZoom({
						style: String(p.style ?? "smooth"),
						scale: Number(p.scale ?? 1.16),
						attack: Number(p.attack ?? 0.5),
						release: Number(p.release ?? 0.5),
						duration: Number(p.spanSeconds ?? 2),
						time: localTime / 120000,
					}),
					u_anchor: [Number(p.anchorX ?? 0.5), Number(p.anchorY ?? 0.4)],
				}),
			},
		],
	},
};
