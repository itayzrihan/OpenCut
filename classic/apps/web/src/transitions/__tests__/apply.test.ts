import { describe, expect, test } from "bun:test";
import type {
	ElementAnimations,
	ScalarAnimationChannel,
} from "@/animation/types";
import type { VideoElement } from "@/timeline";
import {
	TRANSITION_PRESETS,
	buildTransitionAnimations,
	buildTransitionAnimationsFromElement,
	buildTransitionPatch,
} from "@/transitions";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			opacity: 1,
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
		},
		...overrides,
	};
}

function scalarChannel({
	from,
	to,
}: {
	from: number;
	to: number;
}): ScalarAnimationChannel {
	return {
		keys: [
			{
				id: "start",
				time: ZERO_MEDIA_TIME,
				value: from,
				segmentToNext: "linear",
				tangentMode: "flat",
			},
			{
				id: "end",
				time: mediaTimeFromSeconds({ seconds: 10 }),
				value: to,
				segmentToNext: "linear",
				tangentMode: "flat",
			},
		],
	};
}

function keyCount({
	animations,
	propertyPath,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: string;
}) {
	const channel = animations?.[propertyPath];
	return channel && "keys" in channel && Array.isArray(channel.keys)
		? channel.keys.length
		: 0;
}

function keyTimes({
	animations,
	propertyPath,
}: {
	animations: ElementAnimations | undefined;
	propertyPath: string;
}) {
	const channel = animations?.[propertyPath];
	if (!channel || !("keys" in channel) || !Array.isArray(channel.keys)) {
		return [];
	}
	return channel.keys.map((key) =>
		Number(mediaTimeToSeconds({ time: key.time }).toFixed(3)),
	);
}

describe("transitions", () => {
	test("exports a populated transition library", () => {
		const presetIds = TRANSITION_PRESETS.map((preset) => preset.id);

		expect(TRANSITION_PRESETS.length).toBeGreaterThan(80);
		expect(new Set(presetIds).size).toBe(presetIds.length);
		expect(presetIds).toContain("fade");
		expect(presetIds).toContain("glitch");
		expect(presetIds).toContain("shatter");
		expect(presetIds).toContain("dolly-zoom-in");
		expect(presetIds).toContain("whip-pan-left");
		expect(presetIds).toContain("lower-third-reveal-left");
	});

	test("builds in and out animation channels", () => {
		const element = buildVideoElement();
		const animations = buildTransitionAnimations({
			element,
			inTransitionId: "fade",
			outTransitionId: "slide-left",
			inPercent: 20,
			outPercent: 30,
		});

		expect(
			keyCount({ animations, propertyPath: "opacity" }),
		).toBeGreaterThanOrEqual(4);
		expect(
			keyCount({ animations, propertyPath: "transform.positionX" }),
		).toBeGreaterThanOrEqual(3);
	});

	test("builds premium recipe transitions with multi-step motion", () => {
		const element = buildVideoElement();
		const animations = buildTransitionAnimations({
			element,
			inTransitionId: "whip-pan-left",
			outTransitionId: "dolly-zoom-in",
			inPercent: 20,
			outPercent: 20,
		});

		expect(
			keyCount({ animations, propertyPath: "opacity" }),
		).toBeGreaterThanOrEqual(7);
		expect(
			keyCount({ animations, propertyPath: "transform.positionX" }),
		).toBeGreaterThanOrEqual(5);
		expect(
			keyCount({ animations, propertyPath: "transform.scaleX" }),
		).toBeGreaterThanOrEqual(7);
	});

	test("records transition metadata for clip starts and ends", () => {
		const element = buildVideoElement();
		const inPatch = buildTransitionPatch({
			element,
			presetId: "fade",
			side: "in",
			percent: 20,
		});
		const elementWithInTransition: VideoElement = {
			...element,
			animations: inPatch.animations,
			transitions: inPatch.transitions,
		};
		const outPatch = buildTransitionPatch({
			element: elementWithInTransition,
			presetId: "slide-left",
			side: "out",
			percent: 20,
		});

		expect(inPatch.transitions?.in?.presetId).toBe("fade");
		expect(outPatch.transitions?.in?.presetId).toBe("fade");
		expect(outPatch.transitions?.out?.presetId).toBe("slide-left");
	});

	test("uses stored transition start times when building playback animations", () => {
		const element = buildVideoElement({
			transitions: {
				in: {
					id: "transition-in",
					presetId: "fade",
					placement: "in",
					startTime: mediaTimeFromSeconds({ seconds: 2 }),
					duration: mediaTimeFromSeconds({ seconds: 1 }),
					createdAt: "2026-01-01T00:00:00.000Z",
				},
				out: {
					id: "transition-out",
					presetId: "slide-left",
					placement: "out",
					startTime: mediaTimeFromSeconds({ seconds: 6 }),
					duration: mediaTimeFromSeconds({ seconds: 1.5 }),
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});

		const playbackAnimations = buildTransitionAnimationsFromElement({
			element,
		});

		expect(
			keyTimes({ animations: playbackAnimations, propertyPath: "opacity" }),
		).toEqual([0, 2, 3, 6, 7.5, 10]);
		expect(
			keyTimes({
				animations: playbackAnimations,
				propertyPath: "transform.positionX",
			}),
		).toEqual([0, 6, 7.5, 10]);
	});

	test("preserves unrelated keyframes when applying a transition", () => {
		const scaleX = scalarChannel({ from: 1, to: 1.8 });
		const scaleY = scalarChannel({ from: 1, to: 1.4 });
		const opacity = scalarChannel({ from: 1, to: 0.4 });
		const element = buildVideoElement({
			animations: {
				"transform.scaleX": scaleX,
				"transform.scaleY": scaleY,
				opacity,
			},
		});

		const patch = buildTransitionPatch({
			element,
			presetId: "fade",
			side: "in",
			percent: 20,
		});

		expect(patch.animations?.["transform.scaleX"]).toEqual(scaleX);
		expect(patch.animations?.["transform.scaleY"]).toEqual(scaleY);
		expect(patch.animations?.opacity).toBeUndefined();
	});

	test("keeps unrelated keyframes in playback animations with transitions", () => {
		const scaleX = scalarChannel({ from: 1, to: 2 });
		const scaleY = scalarChannel({ from: 1, to: 1.5 });
		const animations: ElementAnimations = {
			"transform.scaleX": scaleX,
			"transform.scaleY": scaleY,
		};
		const element = buildVideoElement({
			animations,
			transitions: {
				in: {
					id: "transition-in",
					presetId: "fade",
					placement: "in",
					duration: mediaTimeFromSeconds({ seconds: 1 }),
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			},
		});

		const playbackAnimations = buildTransitionAnimationsFromElement({
			element,
		});

		expect(playbackAnimations?.["transform.scaleX"]).toEqual(scaleX);
		expect(playbackAnimations?.["transform.scaleY"]).toEqual(scaleY);
		expect(playbackAnimations?.opacity).toBeDefined();
	});
});
