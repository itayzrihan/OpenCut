import { getLoopPreset } from "@/loops/registry";
import type { LoopKey, LoopProperty } from "@/loops/types";
import type { ParamValues } from "@/params";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";

export const PARALLAX_MOTION_LOOP_PARAM_KEYS = {
	presetId: "parallax.motionLoop.presetId",
	amount: "parallax.motionLoop.amount",
	cycleSeconds: "parallax.motionLoop.cycleSeconds",
	startPercent: "parallax.motionLoop.startPercent",
	endPercent: "parallax.motionLoop.endPercent",
} as const;

export const PARALLAX_MOTION_LOOP_PRESETS = [
	{ id: "none", label: "No Loop" },
	{ id: "shake-subtle", label: "Handheld Camera" },
	{ id: "vibration", label: "Energetic Shake" },
	{ id: "soft-drift", label: "Soft Drift" },
	{ id: "sway", label: "Cinematic Sway" },
	{ id: "float", label: "Floating" },
	{ id: "orbit", label: "Gentle Orbit" },
	{ id: "rotation-sway", label: "Rotation Sway" },
	{ id: "zoom-breathe", label: "Zoom Breathe" },
] as const;

const PARALLAX_MOTION_LOOP_IDS = new Set<string>(
	PARALLAX_MOTION_LOOP_PRESETS.map((preset) => preset.id),
);

export interface ParallaxMotionLoopSettings {
	presetId: string;
	amount: number;
	cycleSeconds: number;
	startPercent: number;
	endPercent: number;
}

export interface ParallaxMotionLoopFrame {
	translateX: number;
	translateY: number;
	rotate: number;
	scale: number;
	safeScale: number;
}

export function readParallaxMotionLoopSettings({
	params,
}: {
	params: ParamValues;
}): ParallaxMotionLoopSettings {
	const requestedPreset = readString({
		params,
		key: PARALLAX_MOTION_LOOP_PARAM_KEYS.presetId,
		fallback: "none",
	});
	const presetId = PARALLAX_MOTION_LOOP_IDS.has(requestedPreset)
		? requestedPreset
		: "none";
	const preset = getLoopPreset({ id: presetId });
	const startPercent = clamp({
		value: readNumber({
			params,
			key: PARALLAX_MOTION_LOOP_PARAM_KEYS.startPercent,
			fallback: 0,
		}),
		min: 0,
		max: 99.9,
	});
	const endPercent = clamp({
		value: readNumber({
			params,
			key: PARALLAX_MOTION_LOOP_PARAM_KEYS.endPercent,
			fallback: 100,
		}),
		min: startPercent + 0.1,
		max: 100,
	});

	return {
		presetId,
		amount: clamp({
			value: readNumber({
				params,
				key: PARALLAX_MOTION_LOOP_PARAM_KEYS.amount,
				fallback: 1,
			}),
			min: 0,
			max: 2,
		}),
		cycleSeconds: clamp({
			value: readNumber({
				params,
				key: PARALLAX_MOTION_LOOP_PARAM_KEYS.cycleSeconds,
				fallback: preset.cycleSeconds,
			}),
			min: 0.1,
			max: 12,
		}),
		startPercent,
		endPercent,
	};
}

export function buildParallaxMotionLoopParams({
	params,
	patch,
}: {
	params: ParamValues;
	patch: Partial<ParallaxMotionLoopSettings>;
}): ParamValues {
	const current = readParallaxMotionLoopSettings({ params });
	const next = { ...current, ...patch };
	const startPercent = clamp({ value: next.startPercent, min: 0, max: 99.9 });
	const endPercent = clamp({
		value: next.endPercent,
		min: startPercent + 0.1,
		max: 100,
	});

	return {
		...params,
		[PARALLAX_MOTION_LOOP_PARAM_KEYS.presetId]: next.presetId,
		[PARALLAX_MOTION_LOOP_PARAM_KEYS.amount]: clamp({
			value: next.amount,
			min: 0,
			max: 2,
		}),
		[PARALLAX_MOTION_LOOP_PARAM_KEYS.cycleSeconds]: clamp({
			value: next.cycleSeconds,
			min: 0.1,
			max: 12,
		}),
		[PARALLAX_MOTION_LOOP_PARAM_KEYS.startPercent]: startPercent,
		[PARALLAX_MOTION_LOOP_PARAM_KEYS.endPercent]: endPercent,
	};
}

export function resolveParallaxMotionLoopFrame({
	params,
	localTime,
	duration,
	width,
	height,
}: {
	params: ParamValues;
	localTime: number;
	duration: number;
	width: number;
	height: number;
}): ParallaxMotionLoopFrame | null {
	const settings = readParallaxMotionLoopSettings({ params });
	if (settings.presetId === "none" || settings.amount <= 0) return null;

	const rangeStart = duration * (settings.startPercent / 100);
	const rangeEnd = duration * (settings.endPercent / 100);
	if (localTime < rangeStart || localTime > rangeEnd) return null;

	const loopTime = Math.max(0, localTime - rangeStart);
	const phase =
		(mediaTimeToSeconds({ time: roundMediaTime({ time: loopTime }) }) %
			settings.cycleSeconds) /
		settings.cycleSeconds;
	const preset = getLoopPreset({ id: settings.presetId });
	const rangeDuration = Math.max(1, rangeEnd - rangeStart);
	const edgeFadeDuration = Math.min(
		rangeDuration * 0.08,
		mediaTimeFromSeconds({ seconds: 0.2 }),
	);
	const fadeIn = smoothstep01((localTime - rangeStart) / edgeFadeDuration);
	const fadeOut = smoothstep01((rangeEnd - localTime) / edgeFadeDuration);
	const envelope = Math.min(fadeIn, fadeOut);
	const amount = settings.amount * envelope;

	const translateX = sampleProperty({
		presetId: settings.presetId,
		property: "transform.positionX",
		phase,
	}) * amount;
	const translateY = sampleProperty({
		presetId: settings.presetId,
		property: "transform.positionY",
		phase,
	}) * amount;
	const rotate = sampleProperty({
		presetId: settings.presetId,
		property: "transform.rotate",
		phase,
	}) * amount;
	const scaleX = scaleFromRecipe({
		keys: preset.recipe["transform.scaleX"],
		phase,
		amount,
	});
	const scaleY = scaleFromRecipe({
		keys: preset.recipe["transform.scaleY"],
		phase,
		amount,
	});
	const scale = Math.max(0.05, (scaleX + scaleY) / 2);
	const requiredCoverageScale = calculateSafeViewportScale({
		width,
		height,
		translateX,
		translateY,
		rotate,
	});
	const hasMotion =
		Math.abs(translateX) > 0.0001 ||
		Math.abs(translateY) > 0.0001 ||
		Math.abs(rotate) > 0.0001 ||
		Math.abs(scale - 1) > 0.0001;
	const safetyMargin = hasMotion ? 1.001 : 1;
	const safeScale = Math.max(
		1,
		(requiredCoverageScale * safetyMargin) / scale,
	);

	return {
		translateX,
		translateY,
		rotate,
		scale,
		safeScale,
	};
}

/**
 * Exact containment scale for a translated and rotated source rectangle.
 * It inverse-transforms all four viewport corners and finds the smallest
 * uniform source scale that still contains every corner.
 */
export function calculateSafeViewportScale({
	width,
	height,
	translateX,
	translateY,
	rotate,
}: {
	width: number;
	height: number;
	translateX: number;
	translateY: number;
	rotate: number;
}): number {
	const safeWidth = Math.max(1, width);
	const safeHeight = Math.max(1, height);
	const radians = (rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const translatedX = translateX * cos + translateY * sin;
	const translatedY = -translateX * sin + translateY * cos;
	const requiredX =
		(safeWidth * Math.abs(cos) +
			safeHeight * Math.abs(sin) +
			2 * Math.abs(translatedX)) /
		safeWidth;
	const requiredY =
		(safeWidth * Math.abs(sin) +
			safeHeight * Math.abs(cos) +
			2 * Math.abs(translatedY)) /
		safeHeight;
	return Math.max(1, requiredX, requiredY);
}

function sampleProperty({
	presetId,
	property,
	phase,
}: {
	presetId: string;
	property: LoopProperty;
	phase: number;
}): number {
	const keys = getLoopPreset({ id: presetId }).recipe[property];
	return keys ? interpolateRecipe({ keys, phase }) : 0;
}

function scaleFromRecipe({
	keys,
	phase,
	amount,
}: {
	keys: LoopKey[] | undefined;
	phase: number;
	amount: number;
}): number {
	if (!keys) return 1;
	return 1 + (interpolateRecipe({ keys, phase }) - 1) * amount;
}

function interpolateRecipe({ keys, phase }: { keys: LoopKey[]; phase: number }) {
	if (keys.length === 0) return 0;
	if (phase <= keys[0].at) return keys[0].value;
	for (let index = 1; index < keys.length; index++) {
		const previous = keys[index - 1];
		const next = keys[index];
		if (phase <= next.at) {
			const progress = (phase - previous.at) / Math.max(0.000001, next.at - previous.at);
			return previous.value + (next.value - previous.value) * progress;
		}
	}
	return keys[keys.length - 1].value;
}

function readNumber({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}) {
	const value = params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: string;
}) {
	const value = params[key];
	return typeof value === "string" ? value : fallback;
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

function smoothstep01(value: number) {
	const clamped = clamp({ value, min: 0, max: 1 });
	return clamped * clamped * (3 - 2 * clamped);
}
