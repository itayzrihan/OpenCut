import { describe, expect, test } from "bun:test";
import {
	readCameraLayerSettings,
	resolveCameraDepthFactor,
} from "@/effects/virtual-camera";

describe("virtual camera layer settings", () => {
	test("reads depth and lock values from serializable element params", () => {
		expect(
			readCameraLayerSettings({
				params: { "camera.depth": 1.7, "camera.locked": true },
			}),
		).toEqual({ depth: 1.7, locked: true });
	});

	test("moves backgrounds slower and foregrounds faster under parallax", () => {
		const background = resolveCameraDepthFactor({
			depth: 0.4,
			parallaxStrength: 0.8,
		});
		const subject = resolveCameraDepthFactor({
			depth: 1,
			parallaxStrength: 0.8,
		});
		const foreground = resolveCameraDepthFactor({
			depth: 1.8,
			parallaxStrength: 0.8,
		});

		expect(background).toBeLessThan(subject);
		expect(subject).toBe(1);
		expect(foreground).toBeGreaterThan(subject);
	});
});
