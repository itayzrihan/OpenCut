import type { NumberParamDefinition } from "@/params";

export const PARALLAX_CAMERA_KEYFRAME_PATHS = {
	x: "params.parallax.cameraX",
	y: "params.parallax.cameraY",
	scale: "params.parallax.cameraScale",
} as const;

export const PARALLAX_CAMERA_KEYFRAME_PARAMS: readonly NumberParamDefinition[] = [
	{
		key: "parallax.cameraX",
		label: "Camera X",
		type: "number",
		default: 0,
		min: -100_000,
		step: 0.01,
	},
	{
		key: "parallax.cameraY",
		label: "Camera Y",
		type: "number",
		default: 0,
		min: -100_000,
		step: 0.01,
	},
	{
		key: "parallax.cameraScale",
		label: "Camera Scale",
		type: "number",
		default: 1,
		min: 0.05,
		step: 0.01,
	},
];
