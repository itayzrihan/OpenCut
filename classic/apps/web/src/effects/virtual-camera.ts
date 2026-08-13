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
			? clamp(depthValue, CAMERA_DEPTH_MIN, CAMERA_DEPTH_MAX)
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
	const normalizedDepth = clamp(depth, CAMERA_DEPTH_MIN, CAMERA_DEPTH_MAX);
	const strength = clamp(parallaxStrength, 0, 1);
	return clamp(
		1 + (normalizedDepth - DEFAULT_CAMERA_DEPTH) * strength,
		0.15,
		3,
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
