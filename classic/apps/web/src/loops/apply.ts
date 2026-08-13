import type {
	ScalarAnimationChannel,
	ScalarAnimationKey,
} from "@/animation/types";
import type { TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import { getLoopPreset } from "./registry";
import type {
	LoopKey,
	LoopPreset,
	LoopProperty,
	LoopAnimationPatch,
} from "./types";

const ABSOLUTE_PROPERTIES = new Set<LoopProperty>([
	"opacity",
	"transform.scaleX",
	"transform.scaleY",
]);
const LOOP_PROPERTIES = new Set<string>([
	"opacity",
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
]);

function isLoopProperty(value: string): value is LoopProperty {
	return LOOP_PROPERTIES.has(value);
}

function readBaseValue({
	element,
	property,
}: {
	element: TimelineElement;
	property: LoopProperty;
}): number {
	const value = element.params[property];
	if (typeof value === "number") return value;
	if (
		property === "opacity" ||
		property === "transform.scaleX" ||
		property === "transform.scaleY"
	) {
		return 1;
	}
	return 0;
}

function interpolateRecipeValue({
	recipe,
	phase,
}: {
	recipe: LoopKey[];
	phase: number;
}): number {
	if (recipe.length === 0) return 0;
	if (phase <= recipe[0].at) return recipe[0].value;
	for (let index = 1; index < recipe.length; index++) {
		const next = recipe[index];
		const previous = recipe[index - 1];
		if (phase <= next.at) {
			const span = Math.max(0.000001, next.at - previous.at);
			const amount = (phase - previous.at) / span;
			return previous.value + (next.value - previous.value) * amount;
		}
	}
	return recipe[recipe.length - 1].value;
}

function toChannel({
	keys,
}: {
	keys: Array<{ time: number; value: number }>;
}): ScalarAnimationChannel {
	const unique: Array<{ time: number; value: number }> = [];
	for (const key of keys.sort((left, right) => left.time - right.time)) {
		const previous = unique[unique.length - 1];
		if (previous && Math.abs(previous.time - key.time) < 0.0005) {
			unique[unique.length - 1] = key;
		} else {
			unique.push(key);
		}
	}
	return {
		keys: unique.map<ScalarAnimationKey>((key) => ({
			id: generateUUID(),
			time: mediaTimeFromSeconds({ seconds: key.time }),
			value: key.value,
			segmentToNext: "linear",
			tangentMode: "auto",
		})),
	};
}

function buildLoopChannel({
	element,
	preset,
	property,
	durationSeconds,
}: {
	element: TimelineElement;
	preset: LoopPreset;
	property: LoopProperty;
	durationSeconds: number;
}): ScalarAnimationChannel {
	const recipe = preset.recipe[property] ?? [];
	const cycleSeconds = Math.max(0.05, preset.cycleSeconds);
	const base = readBaseValue({ element, property });
	const accumulate = preset.accumulate?.includes(property) ?? false;
	const cycleCount = Math.max(1, Math.ceil(durationSeconds / cycleSeconds));
	const keys: Array<{ time: number; value: number }> = [];

	for (let cycle = 0; cycle < cycleCount; cycle++) {
		const cycleStart = cycle * cycleSeconds;
		const cycleDelta = accumulate
			? (recipe[recipe.length - 1]?.value ?? 0) - (recipe[0]?.value ?? 0)
			: 0;
		for (const point of recipe) {
			const time = cycleStart + point.at * cycleSeconds;
			if (time > durationSeconds + 0.0005) continue;
			const rawValue = point.value + cycle * cycleDelta;
			keys.push({
				time: Math.min(durationSeconds, time),
				value: ABSOLUTE_PROPERTIES.has(property) ? rawValue : base + rawValue,
			});
		}
	}

	if (
		keys.length === 0 ||
		keys[keys.length - 1].time < durationSeconds - 0.0005
	) {
		const phase = (durationSeconds % cycleSeconds) / cycleSeconds;
		const cycle = Math.max(0, Math.ceil(durationSeconds / cycleSeconds) - 1);
		const cycleDelta = accumulate
			? (recipe[recipe.length - 1]?.value ?? 0) - (recipe[0]?.value ?? 0)
			: 0;
		const rawValue =
			interpolateRecipeValue({ recipe, phase }) + cycle * cycleDelta;
		keys.push({
			time: durationSeconds,
			value: ABSOLUTE_PROPERTIES.has(property) ? rawValue : base + rawValue,
		});
	}

	return toChannel({ keys });
}

export function buildLoopPatch({
	element,
	loopId,
}: {
	element: TimelineElement;
	loopId: string;
}): LoopAnimationPatch {
	const preset = getLoopPreset({ id: loopId });
	const nextAnimations = { ...(element.animations ?? {}) };
	const properties = new Set<LoopProperty>(
		(element.loop?.properties ?? []).filter(isLoopProperty),
	);
	for (const property of Object.keys(preset.recipe).filter(isLoopProperty)) {
		properties.add(property);
	}
	for (const property of properties) {
		delete nextAnimations[property];
	}

	if (preset.id === "none") {
		return {
			animations:
				Object.keys(nextAnimations).length > 0 ? nextAnimations : undefined,
			loop: undefined,
		};
	}

	const durationSeconds = Math.max(
		0.001,
		mediaTimeToSeconds({ time: element.duration }),
	);
	const loopProperties = Object.keys(preset.recipe).filter(isLoopProperty);
	for (const property of loopProperties) {
		nextAnimations[property] = buildLoopChannel({
			element,
			preset,
			property,
			durationSeconds,
		});
	}

	return {
		animations: nextAnimations,
		loop: {
			presetId: preset.id,
			cycleSeconds: preset.cycleSeconds,
			properties: loopProperties,
		},
	};
}
