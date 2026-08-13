"use client";

import { useEditor } from "@/editor/use-editor";
import {
	buildGraphicParamPath,
	getElementKeyframes,
	getKeyframeAtTime,
	hasKeyframesForPath,
	upsertPathKeyframe,
} from "@/animation";
import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import {
	coerceParamValue,
	getParamChannelLayout,
	type ParamDefinition,
} from "@/params";
import type { TimelineElement } from "@/timeline";
import { addMediaTime, type MediaTime } from "@/wasm";
import { findAdjacentKeyframeTimes } from "./keyframe-navigation";

export interface KeyframedParamPropertyResult {
	hasAnimatedKeyframes: boolean;
	isKeyframedAtTime: boolean;
	keyframeIdAtTime: string | null;
	hasPreviousKeyframe: boolean;
	hasNextKeyframe: boolean;
	goToPreviousKeyframe: () => void;
	goToNextKeyframe: () => void;
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
	toggleKeyframe: () => void;
}

export function useKeyframedParamProperty({
	param,
	trackId,
	elementId,
	elementStartTime,
	animations,
	propertyPath,
	localTime,
	isPlayheadWithinElementRange,
	resolvedValue,
	buildBaseUpdates,
	enabled = true,
}: {
	param: ParamDefinition;
	trackId: string;
	elementId: string;
	elementStartTime: MediaTime;
	animations: ElementAnimations | undefined;
	propertyPath?: AnimationPath;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
	resolvedValue: number | string | boolean;
	buildBaseUpdates: ({
		value,
	}: {
		value: number | string | boolean;
	}) => Partial<TimelineElement>;
	enabled?: boolean;
}): KeyframedParamPropertyResult {
	const editor = useEditor();
	const resolvedPropertyPath =
		propertyPath ?? buildGraphicParamPath({ paramKey: param.key });
	const hasAnimatedKeyframes = enabled
		? hasKeyframesForPath({
				animations,
				propertyPath: resolvedPropertyPath,
			})
		: false;
	const keyframeAtTime = enabled && isPlayheadWithinElementRange
		? getKeyframeAtTime({
				animations,
				propertyPath: resolvedPropertyPath,
				time: localTime,
			})
		: null;
	const keyframeIdAtTime = keyframeAtTime?.id ?? null;
	const isKeyframedAtTime = keyframeAtTime !== null;
	const keyframeTimes = getElementKeyframes({ animations })
		.filter((keyframe) => keyframe.propertyPath === resolvedPropertyPath)
		.map((keyframe) => keyframe.time);
	const { previous: previousKeyframeTime, next: nextKeyframeTime } =
		findAdjacentKeyframeTimes({ keyframeTimes, currentTime: localTime });
	const seekToKeyframe = ({ time }: { time: MediaTime | null }) => {
		if (time === null) return;
		editor.playback.seek({
			time: addMediaTime({ a: elementStartTime, b: time }),
		});
	};
	const shouldUseAnimatedChannel =
		enabled && hasAnimatedKeyframes && isPlayheadWithinElementRange;

	const previewValue: KeyframedParamPropertyResult["onPreview"] = (value) => {
		if (shouldUseAnimatedChannel) {
			editor.timeline.previewElements({
				updates: [
					{
						trackId,
						elementId,
						updates: {
							animations: upsertPathKeyframe({
								animations,
								propertyPath: resolvedPropertyPath,
								time: localTime,
								value,
								channelLayout: getParamChannelLayout({ param }),
								coerceValue: ({ value: nextValue }) =>
									coerceParamValue({
										param,
										value: nextValue,
									}),
							}),
						},
					},
				],
			});
			return;
		}

		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId,
					updates: buildBaseUpdates({ value }),
				},
			],
		});
	};

	const toggleKeyframe = () => {
		if (!enabled || !isPlayheadWithinElementRange) {
			return;
		}

		if (keyframeIdAtTime) {
			editor.timeline.removeKeyframes({
				keyframes: [
					{
						trackId,
						elementId,
						propertyPath: resolvedPropertyPath,
						keyframeId: keyframeIdAtTime,
					},
				],
			});
			return;
		}

		editor.timeline.upsertKeyframes({
			keyframes: [
				{
					trackId,
					elementId,
					propertyPath: resolvedPropertyPath,
					time: localTime,
					value: resolvedValue,
				},
			],
		});
	};

	return {
		hasAnimatedKeyframes,
		isKeyframedAtTime,
		keyframeIdAtTime,
		hasPreviousKeyframe: previousKeyframeTime !== null,
		hasNextKeyframe: nextKeyframeTime !== null,
		goToPreviousKeyframe: () => seekToKeyframe({ time: previousKeyframeTime }),
		goToNextKeyframe: () => seekToKeyframe({ time: nextKeyframeTime }),
		onPreview: previewValue,
		onCommit: () => editor.timeline.commitPreview(),
		toggleKeyframe,
	};
}
