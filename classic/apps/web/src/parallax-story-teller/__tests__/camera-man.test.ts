import { describe, expect, test } from "bun:test";
import type { ChannelData, ScalarAnimationChannel } from "@/animation/types";
import { mediaTime } from "@/wasm";
import {
	cameraManSamplesToAnimations,
	easeCameraManSamples,
	spreadCameraManSamples,
	type CameraManSample,
} from "../camera-man";
import { PARALLAX_CAMERA_KEYFRAME_PATHS } from "../camera-keyframes";

const sample = ({ time, x }: { time: number; x: number }): CameraManSample => ({
	time: mediaTime({ ticks: time }),
	x,
	y: 0,
	scale: 1,
});

function isScalarAnimationChannel(
	channel: ChannelData | undefined,
): channel is ScalarAnimationChannel {
	return channel !== undefined && "keys" in channel && Array.isArray(channel.keys);
}

describe("Camera Man processing", () => {
	test("reduces a straight recording to its endpoints", () => {
		const eased = easeCameraManSamples({
			samples: [
				sample({ time: 0, x: 0 }),
				sample({ time: 50, x: 0.5 }),
				sample({ time: 100, x: 1 }),
			],
		});
		expect(eased.map((item) => Number(item.time))).toEqual([0, 100]);
	});

	test("spreads motion by traveled distance over the full scene", () => {
		const spread = spreadCameraManSamples({
			samples: [
				sample({ time: 20, x: 0 }),
				sample({ time: 30, x: 1 }),
				sample({ time: 40, x: 3 }),
			],
			duration: mediaTime({ ticks: 300 }),
		});
		expect(spread.map((item) => Number(item.time))).toEqual([0, 100, 300]);
	});

	test("writes editable camera channels", () => {
		const animations = cameraManSamplesToAnimations({
			samples: [sample({ time: 0, x: 0 }), sample({ time: 100, x: 1 })],
		});
		const xChannel = animations[PARALLAX_CAMERA_KEYFRAME_PATHS.x];
		expect(isScalarAnimationChannel(xChannel)).toBeTrue();
		if (!isScalarAnimationChannel(xChannel)) throw new Error("Expected scalar channel");
		expect(xChannel.keys).toHaveLength(2);
	});
});
