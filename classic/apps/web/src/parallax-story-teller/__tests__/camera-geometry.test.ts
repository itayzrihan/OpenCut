import { describe, expect, test } from "bun:test";
import {
	getParallaxCameraWorldCenter,
	getParallaxWorldOriginOffset,
	mapParallaxParentTimeToSourceTime,
} from "../camera-geometry";

describe("parallax camera geometry", () => {
	test("resolves the current camera center in world coordinates", () => {
		expect(
			getParallaxCameraWorldCenter({
				cameraWidth: 1080,
				cameraHeight: 1920,
				worldWidthFrames: 3,
				worldHeightFrames: 2,
				camera: { x: 0.5, y: -0.25 },
			}),
		).toEqual({ x: 2160, y: 1440 });
	});

	test("rebases world coordinates onto the camera-sized output", () => {
		expect(
			getParallaxWorldOriginOffset({
				cameraWidth: 1080,
				cameraHeight: 1920,
				worldWidthFrames: 3,
				worldHeightFrames: 2,
			}),
		).toEqual({ x: 1080, y: 960 });
	});

	test("maps parent playback time onto the canvas scene clock", () => {
		expect(
			mapParallaxParentTimeToSourceTime({
				time: 4,
				timeOffset: 1,
				duration: 6,
				sourceDuration: 12,
			}),
		).toBe(6);
	});
});
