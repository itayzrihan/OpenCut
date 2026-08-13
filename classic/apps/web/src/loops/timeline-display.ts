import { getElementKeyframes } from "@/animation";
import type { ElementAnimations, ElementKeyframe } from "@/animation/types";
import type { ElementLoop } from "@/timeline";

export function getAnimationsWithoutAppliedLoop({
	animations,
	loop,
}: {
	animations: ElementAnimations | undefined;
	loop: ElementLoop | undefined;
}): ElementAnimations | undefined {
	if (!animations || !loop) return animations;
	const loopProperties = new Set(loop.properties);
	const result: ElementAnimations = {};
	for (const [propertyPath, channel] of Object.entries(animations)) {
		if (!loopProperties.has(propertyPath)) {
			result[propertyPath] = channel;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function getAppliedLoopKeyframes({
	animations,
	loop,
}: {
	animations: ElementAnimations | undefined;
	loop: ElementLoop | undefined;
}): ElementKeyframe[] {
	if (!animations || !loop) return [];
	const loopProperties = new Set(loop.properties);
	return getElementKeyframes({ animations }).filter((keyframe) =>
		loopProperties.has(keyframe.propertyPath),
	);
}

export function groupLoopKeyframesByProperty({
	keyframes,
}: {
	keyframes: ElementKeyframe[];
}): Array<{ propertyPath: string; keyframes: ElementKeyframe[] }> {
	const groups = new Map<string, ElementKeyframe[]>();
	for (const keyframe of keyframes) {
		const group = groups.get(keyframe.propertyPath) ?? [];
		group.push(keyframe);
		groups.set(keyframe.propertyPath, group);
	}
	return [...groups.entries()].map(([propertyPath, propertyKeyframes]) => ({
		propertyPath,
		keyframes: propertyKeyframes.sort((left, right) => left.time - right.time),
	}));
}
