import type { ParamValues } from "@/params";

export const CAMERA_DEPTH_PARAM = "camera.depth";
export const CAMERA_LOCKED_PARAM = "camera.locked";

export const CAMERA_DEPTH_MIN = 0.1;
export const CAMERA_DEPTH_MAX = 4;
export const DEFAULT_CAMERA_DEPTH = 1;

export interface CameraLayerSettings {
	depth: number;
	locked: boolean;
	motionFactor?: number;
}

export function readCameraLayerSettings({
	params,
}: {
	params: ParamValues | Record<string, unknown>;
}): CameraLayerSettings {
	const depthValue = params[CAMERA_DEPTH_PARAM];
	const depth =
		typeof depthValue === "number" && Number.isFinite(depthValue)
			? clamp({
					value: depthValue,
					min: CAMERA_DEPTH_MIN,
					max: CAMERA_DEPTH_MAX,
				})
			: DEFAULT_CAMERA_DEPTH;

	return {
		depth,
		locked: params[CAMERA_LOCKED_PARAM] === true,
	};
}

export function resolveCameraDepthFactor({
	depth,
	parallaxStrength,
}: {
	depth: number;
	parallaxStrength: number;
}): number {
	const normalizedDepth = clamp({
		value: depth,
		min: CAMERA_DEPTH_MIN,
		max: CAMERA_DEPTH_MAX,
	});
	const strength = clamp({ value: parallaxStrength, min: 0, max: 1 });
	return clamp({
		value: 1 + (normalizedDepth - DEFAULT_CAMERA_DEPTH) * strength,
		min: 0.15,
		max: 3,
	});
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.max(min, Math.min(max, value));
}
