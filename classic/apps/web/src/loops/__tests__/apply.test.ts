import { describe, expect, test } from "bun:test";
import type { TextElement, VideoElement } from "@/timeline";
import {
	LOOP_PRESETS,
	LOOP_TARGET_ELEMENT_TYPES,
	buildLoopPatch,
	getAnimationsWithoutAppliedLoop,
	getAppliedLoopKeyframes,
} from "@/loops";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";

function buildVideo(overrides: Partial<VideoElement> = {}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video",
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 8 }),
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

function buildText(overrides: Partial<TextElement> = {}): TextElement {
	return {
		id: "text-1",
		type: "text",
		name: "Standalone text",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 4 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			content: "Loop me",
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
		},
		...overrides,
	};
}

function getChannelValues({
	animations,
	property,
}: {
	animations: VideoElement["animations"];
	property: string;
}) {
	const channel = animations?.[property];
	return channel && "keys" in channel
		? channel.keys.map((key) => ({
				time: mediaTimeToSeconds({ time: key.time }),
				value: key.value,
			}))
		: [];
}

describe("loops", () => {
	test("publishes a broad loop library including requested motion families", () => {
		const ids = new Set(LOOP_PRESETS.map((preset) => preset.id));

		expect(ids.size).toBeGreaterThanOrEqual(18);
		expect(ids).toContain("vibration");
		expect(ids).toContain("side-to-side");
		expect(ids).toContain("spin");
		expect(ids).toContain("flicker");
		expect(ids).toContain("breath-expand");
		expect(ids).toContain("fade-30");
	});

	test("accepts standalone text as a loop drop target", () => {
		expect(LOOP_TARGET_ELEMENT_TYPES).toContain("text");
	});

	test("builds repeating channels across the full element duration", () => {
		const patch = buildLoopPatch({
			element: buildVideo(),
			loopId: "side-to-side",
		});
		const values = getChannelValues({
			animations: patch.animations,
			property: "transform.positionX",
		});

		expect(values[0]).toMatchObject({ time: 0, value: -42 });
		expect(values.at(-1)?.time).toBe(8);
		expect(values.at(-1)?.value).toBeCloseTo(14, 5);
		expect(values.some((entry) => entry.value === 42)).toBe(true);
		expect(patch.loop?.presetId).toBe("side-to-side");
	});

	test("accumulates spin rotation instead of snapping at cycle boundaries", () => {
		const patch = buildLoopPatch({
			element: buildVideo(),
			loopId: "spin",
		});
		const values = getChannelValues({
			animations: patch.animations,
			property: "transform.rotate",
		});

		expect(values.at(-1)?.value).toBeGreaterThan(1000);
		expect(
			values.every(
				(entry, index) => index === 0 || entry.value >= values[index - 1].value,
			),
		).toBe(true);
	});

	test("replaces a previous loop while preserving unrelated animation channels", () => {
		const firstPatch = buildLoopPatch({
			element: buildVideo(),
			loopId: "vibration",
		});
		const elementWithLoop = buildVideo({
			animations: {
				...firstPatch.animations,
				opacity: {
					keys: [
						{
							id: "opacity-key",
							time: ZERO_MEDIA_TIME,
							value: 1,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
					],
				},
			},
			loop: firstPatch.loop,
		});
		const nextPatch = buildLoopPatch({
			element: elementWithLoop,
			loopId: "fade-30",
		});

		expect(nextPatch.animations?.["transform.positionX"]).toBeUndefined();
		expect(nextPatch.animations?.opacity).toBeDefined();
		expect(nextPatch.loop?.presetId).toBe("fade-30");
	});

	test("applies transform loops to standalone text elements", () => {
		const patch = buildLoopPatch({
			element: buildText(),
			loopId: "sway",
		});

		expect(patch.loop?.presetId).toBe("sway");
		expect(patch.animations?.["transform.positionX"]).toBeDefined();
		expect(patch.animations?.["transform.rotate"]).toBeDefined();
	});

	test("separates generated loop keyframes from manually authored channels", () => {
		const loopPatch = buildLoopPatch({
			element: buildText(),
			loopId: "sway",
		});
		const manualOpacity = {
			keys: [
				{
					id: "manual-opacity",
					time: ZERO_MEDIA_TIME,
					value: 0.8,
					segmentToNext: "linear" as const,
					tangentMode: "flat" as const,
				},
			],
		};
		const animations = { ...loopPatch.animations, opacity: manualOpacity };
		const nonLoopAnimations = getAnimationsWithoutAppliedLoop({
			animations,
			loop: loopPatch.loop,
		});
		const loopKeyframes = getAppliedLoopKeyframes({
			animations,
			loop: loopPatch.loop,
		});

		expect(nonLoopAnimations).toEqual({ opacity: manualOpacity });
		expect(loopKeyframes.length).toBeGreaterThan(4);
		expect(
			loopKeyframes.every((keyframe) =>
				loopPatch.loop?.properties.some(
					(propertyPath) => propertyPath === keyframe.propertyPath,
				),
			),
		).toBeTrue();
	});
});
