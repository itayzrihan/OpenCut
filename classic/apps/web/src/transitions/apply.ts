import type {
	ElementAnimations,
	ScalarAnimationChannel,
	ScalarAnimationKey,
} from "@/animation/types";
import type { TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import {
	CONTROLLED_TRANSITION_PROPERTIES,
	getTransitionPreset,
} from "./registry";
import type {
	BuildTransitionAnimationsParams,
	TransitionPreset,
	TransitionProperty,
	TransitionState,
} from "./types";

export const DEFAULT_TRANSITION_PERCENT = 5;
export const MAX_DEFAULT_TRANSITION_SECONDS = 3;

export function clampTransitionPercent(value: number) {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function readBaseValue({
	element,
	property,
}: {
	element: TimelineElement;
	property: TransitionProperty;
}) {
	const value = element.params[property];
	if (typeof value === "number") return value;
	if (property === "opacity") return 1;
	if (property === "transform.scaleX" || property === "transform.scaleY") {
		return 1;
	}
	if (property === "background.cornerRadius") return 0;
	return 0;
}

function transitionValue({
	element,
	property,
	state,
}: {
	element: TimelineElement;
	property: TransitionProperty;
	state: TransitionState;
}) {
	const base = readBaseValue({ element, property });
	const offset = state[property];
	if (offset == null) return base;
	if (
		property === "opacity" ||
		property === "transition.shatter" ||
		property === "transform.scaleX" ||
		property === "transform.scaleY"
	) {
		return offset;
	}
	return base + offset;
}

function transitionRecipeValue({
	element,
	property,
	value,
}: {
	element: TimelineElement;
	property: TransitionProperty;
	value: number;
}) {
	const base = readBaseValue({ element, property });
	if (
		property === "opacity" ||
		property === "transition.shatter" ||
		property === "transform.scaleX" ||
		property === "transform.scaleY"
	) {
		return value;
	}
	return base + value;
}

function getPresetProperties({ preset }: { preset: TransitionPreset }) {
	return new Set(
		CONTROLLED_TRANSITION_PROPERTIES.filter(
			(property) =>
				preset.state[property] != null || preset.recipe?.[property] != null,
		),
	);
}

function getPresetPropertiesById({ presetId }: { presetId: string }) {
	return getPresetProperties({ preset: getTransitionPreset({ id: presetId }) });
}

function getTransitionProperties({
	inTransitionId,
	outTransitionId,
}: {
	inTransitionId: string;
	outTransitionId: string;
}) {
	return new Set([
		...getPresetPropertiesById({ presetId: inTransitionId }),
		...getPresetPropertiesById({ presetId: outTransitionId }),
	]);
}

function stripTransitionAnimationChannels({
	animations,
	inTransitionId,
	outTransitionId,
}: {
	animations: ElementAnimations | undefined;
	inTransitionId: string;
	outTransitionId: string;
}): ElementAnimations | undefined {
	if (!animations) return undefined;
	const nextAnimations: ElementAnimations = { ...animations };
	for (const property of getTransitionProperties({
		inTransitionId,
		outTransitionId,
	})) {
		delete nextAnimations[property];
	}
	return Object.keys(nextAnimations).length > 0 ? nextAnimations : undefined;
}

function buildInKeysForProperty({
	element,
	property,
	preset,
	inStart,
	inEnd,
}: {
	element: TimelineElement;
	property: TransitionProperty;
	preset: TransitionPreset;
	inStart: number;
	inEnd: number;
}) {
	const base = readBaseValue({ element, property });
	if (inEnd <= inStart) return [{ time: inStart, value: base }];

	const recipe = preset.recipe?.[property];
	if (recipe?.length) {
		return recipe.map((key) => ({
			time: inStart + key.at * (inEnd - inStart),
			value: transitionRecipeValue({
				element,
				property,
				value: key.value,
			}),
		}));
	}

	return [
		{
			time: inStart,
			value: transitionValue({ element, property, state: preset.state }),
		},
		{ time: inEnd, value: base },
	];
}

function buildOutKeysForProperty({
	element,
	property,
	preset,
	outStart,
	outEnd,
}: {
	element: TimelineElement;
	property: TransitionProperty;
	preset: TransitionPreset;
	outStart: number;
	outEnd: number;
}) {
	const base = readBaseValue({ element, property });
	if (outEnd <= outStart) {
		return [{ time: outStart, value: base }];
	}

	const recipe = preset.recipe?.[property];
	if (recipe?.length) {
		return recipe.map((key) => ({
			time: outStart + (1 - key.at) * (outEnd - outStart),
			value: transitionRecipeValue({
				element,
				property,
				value: key.value,
			}),
		}));
	}

	return [
		{ time: outStart, value: base },
		{
			time: outEnd,
			value: transitionValue({ element, property, state: preset.state }),
		},
	];
}

function scalarKey({
	time,
	value,
}: {
	time: number;
	value: number;
}): ScalarAnimationKey {
	return {
		id: generateUUID(),
		time: mediaTimeFromSeconds({ seconds: time }),
		value,
		segmentToNext: "linear",
		tangentMode: "flat",
	};
}

function scalarChannel({
	keys,
}: {
	keys: Array<{ time: number; value: number }>;
}): ScalarAnimationChannel {
	const uniqueKeys: Array<{ time: number; value: number }> = [];
	for (const key of keys) {
		const lastKey = uniqueKeys[uniqueKeys.length - 1];
		if (lastKey && Math.abs(key.time - lastKey.time) <= 0.0005) {
			uniqueKeys[uniqueKeys.length - 1] = key;
			continue;
		}
		uniqueKeys.push(key);
	}
	return {
		keys: uniqueKeys.map((key) => scalarKey(key)),
	};
}

export function buildTransitionAnimations({
	element,
	inTransitionId,
	outTransitionId,
	inDuration,
	outDuration,
	inStartTime,
	outStartTime,
	inPercent,
	outPercent,
}: BuildTransitionAnimationsParams) {
	const durationSeconds = Math.max(
		0.001,
		mediaTimeToSeconds({ time: element.duration }),
	);
	const inPreset = getTransitionPreset({ id: inTransitionId });
	const outPreset = getTransitionPreset({ id: outTransitionId });
	const inDurationSeconds =
		inDuration !== undefined
			? mediaTimeToSeconds({ time: inDuration })
			: durationSeconds * (clampTransitionPercent(inPercent ?? 0) / 100);
	const outDurationSeconds =
		outDuration !== undefined
			? mediaTimeToSeconds({ time: outDuration })
			: durationSeconds * (clampTransitionPercent(outPercent ?? 0) / 100);
	const inStart = clampTransitionSeconds({
		value:
			inStartTime !== undefined ? mediaTimeToSeconds({ time: inStartTime }) : 0,
		durationSeconds,
	});
	const inEnd = clampTransitionSeconds({
		value: inStart + inDurationSeconds,
		durationSeconds,
	});
	const outStart = clampTransitionSeconds({
		value:
			outStartTime !== undefined
				? mediaTimeToSeconds({ time: outStartTime })
				: durationSeconds - outDurationSeconds,
		durationSeconds,
	});
	const outEnd = clampTransitionSeconds({
		value: outStart + outDurationSeconds,
		durationSeconds,
	});
	const nextAnimations: ElementAnimations = { ...(element.animations ?? {}) };
	const inProperties = getPresetProperties({ preset: inPreset });
	const outProperties = getPresetProperties({ preset: outPreset });

	for (const property of CONTROLLED_TRANSITION_PROPERTIES) {
		const usesIn = inProperties.has(property);
		const usesOut = outProperties.has(property);
		if (!usesIn && !usesOut) continue;

		delete nextAnimations[property];
		const base = readBaseValue({ element, property });
		const keys: Array<{ time: number; value: number }> = [];
		if (usesIn) {
			const inKeys = buildInKeysForProperty({
				element,
				property,
				preset: inPreset,
				inStart,
				inEnd,
			});
			const firstInKey = inKeys[0];
			if (firstInKey && firstInKey.time > 0) {
				keys.push({ time: 0, value: firstInKey.value });
			}
			keys.push(...inKeys);
		} else {
			keys.push({ time: 0, value: base });
		}
		if (usesOut) {
			const outKeys = buildOutKeysForProperty({
				element,
				property,
				preset: outPreset,
				outStart,
				outEnd,
			});
			keys.push(...outKeys);
			const lastOutKey = outKeys[outKeys.length - 1];
			if (lastOutKey && lastOutKey.time < durationSeconds) {
				keys.push({ time: durationSeconds, value: lastOutKey.value });
			}
		} else {
			keys.push({ time: durationSeconds, value: base });
		}

		nextAnimations[property] = scalarChannel({
			keys: keys.sort((left, right) => left.time - right.time),
		});
	}

	return Object.keys(nextAnimations).length > 0 ? nextAnimations : undefined;
}

function clampTransitionSeconds({
	value,
	durationSeconds,
}: {
	value: number;
	durationSeconds: number;
}) {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(durationSeconds, value));
}

export function buildTransitionPatch({
	element,
	presetId,
	side,
	percent,
	duration,
}: {
	element: TimelineElement;
	presetId: string;
	side: "in" | "out";
	percent?: number;
	duration?: MediaTime;
}): Partial<TimelineElement> {
	const transitionDuration =
		duration ??
		mediaTimeFromSeconds({
			seconds: getDefaultTransitionDurationSeconds({ element, percent }),
		});
	const nextTransitions = { ...(element.transitions ?? {}) };

	if (presetId === "none") {
		delete nextTransitions[side];
		return {
			animations: stripTransitionAnimationChannels({
				animations: element.animations,
				inTransitionId: nextTransitions.in?.presetId ?? "none",
				outTransitionId: nextTransitions.out?.presetId ?? "none",
			}),
			transitions:
				nextTransitions.in || nextTransitions.out ? nextTransitions : undefined,
		};
	}

	return {
		animations: stripTransitionAnimationChannels({
			animations: element.animations,
			inTransitionId:
				side === "in" ? presetId : (nextTransitions.in?.presetId ?? "none"),
			outTransitionId:
				side === "out" ? presetId : (nextTransitions.out?.presetId ?? "none"),
		}),
		transitions: {
			...nextTransitions,
			[side]: {
				id: generateUUID(),
				presetId,
				placement: side,
				duration: transitionDuration,
				startTime: side === "out" ? element.duration - transitionDuration : 0,
				createdAt: new Date().toISOString(),
			},
		},
	};
}

export function getDefaultTransitionDurationSeconds({
	element,
	percent = DEFAULT_TRANSITION_PERCENT,
}: {
	element: TimelineElement;
	percent?: number;
}): number {
	const elementSeconds = mediaTimeToSeconds({ time: element.duration });
	const percentSeconds =
		(elementSeconds * clampTransitionPercent(percent)) / 100;
	return Math.max(0, Math.min(percentSeconds, MAX_DEFAULT_TRANSITION_SECONDS));
}

export function buildTransitionAnimationsFromElement({
	element,
}: {
	element: TimelineElement;
}): ElementAnimations | undefined {
	const inTransitionId = element.transitions?.in?.presetId ?? "none";
	const outTransitionId = element.transitions?.out?.presetId ?? "none";
	if (inTransitionId === "none" && outTransitionId === "none") {
		return element.animations;
	}

	return buildTransitionAnimations({
		element,
		inTransitionId,
		outTransitionId,
		inDuration: element.transitions?.in?.duration,
		outDuration: element.transitions?.out?.duration,
		inStartTime: element.transitions?.in?.startTime,
		outStartTime: element.transitions?.out?.startTime,
	});
}
