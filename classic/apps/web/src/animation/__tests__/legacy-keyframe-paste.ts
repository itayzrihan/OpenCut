// Parity oracle retained from Classic before canonical clipboard migration.
import {
	getKeyframeAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "@/animation";
import type { KeyframeClipboardItem } from "@/clipboard";
import type { TimelineElement } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export function pasteKeyframesIntoElement({
	element,
	time,
	clipboardItems,
}: {
	element: TimelineElement;
	time: MediaTime;
	clipboardItems: KeyframeClipboardItem[];
}): TimelineElement {
	let nextElement = element;

	for (const item of clipboardItems) {
		const target = resolveAnimationTarget({
			element: nextElement,
			path: item.propertyPath,
		});
		if (!target) {
			continue;
		}

		const keyframeTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: minMediaTime({
				a: addMediaTime({ a: time, b: item.timeOffset }),
				b: nextElement.duration,
			}),
		});
		const nextAnimations = upsertPathKeyframe({
			animations: nextElement.animations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
			value: item.value,
			interpolation: item.interpolation,
			keyframeId: generateUUID(),
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
		const pastedKeyframe = getKeyframeAtTime({
			animations: nextAnimations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
		});

		let patchedAnimations = nextAnimations;
		if (pastedKeyframe) {
			for (const curvePatch of item.curvePatches) {
				const nextPatchedAnimations = updateScalarKeyframeCurve({
					animations: patchedAnimations,
					propertyPath: item.propertyPath,
					componentKey: curvePatch.componentKey,
					keyframeId: pastedKeyframe.id,
					patch: curvePatch.patch,
				});
				patchedAnimations = nextPatchedAnimations ?? patchedAnimations;
			}
		}

		nextElement = {
			...nextElement,
			animations: patchedAnimations,
		};
	}

	return nextElement;
}
