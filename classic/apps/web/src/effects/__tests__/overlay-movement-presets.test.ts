import { describe, expect, test } from "bun:test";
import {
	getOverlayMovementDefaultSfx,
	OVERLAY_MOVEMENT_PRESETS,
	resolveOverlayMovementFrame,
} from "@/effects/overlay-movement-presets";
import { PARALLAX_CAMERA_KEYFRAME_PATHS } from "@/parallax-story-teller/camera-keyframes";

describe("overlay movement presets", () => {
	test("resolve curve zoom progress from layer duration", () => {
		const preset = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "curve-zoom-in-out",
		);
		if (!preset) throw new Error("Missing curve zoom preset");

		const start = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 0,
			duration: 100,
			width: 1920,
			height: 1080,
		});
		const middle = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 50,
			duration: 100,
			width: 1920,
			height: 1080,
		});
		const end = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 100,
			duration: 100,
			width: 1920,
			height: 1080,
		});

		expect(start?.scale).toBeCloseTo(1);
		expect(middle?.scale).toBeGreaterThan(1.2);
		expect(end?.scale).toBeCloseTo(1);
	});

	test("exposes preset default sfx metadata", () => {
		const preset = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "instant-zoom",
		);
		if (!preset) throw new Error("Missing instant zoom preset");

		expect(getOverlayMovementDefaultSfx({ params: preset.params })).toEqual({
			assetId: "5414c56f-e1de-4d7e-bc26-26a6170d496c",
			name: "Snap",
		});
	});

	test("preserves the authored Camera Flash companion sound by asset id", () => {
		const preset = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "camera-flash",
		);
		if (!preset) throw new Error("Missing Camera Flash preset");

		expect(getOverlayMovementDefaultSfx({ params: preset.params })).toEqual({
			assetId: "1feab1d1-0580-41a4-8ed9-4a177eaf675e",
			name: "Camera Flash",
			autoInsert: true,
			startOffsetSeconds: 0,
			durationSeconds: 2.3983666666666665,
			sourceDurationSeconds: 7.758366666666667,
			trimStartSeconds: 0,
			trimEndSeconds: 5.36,
			volume: -16.4,
		});
	});

	test("adds longer handheld instant zoom variants without changing the original", () => {
		const original = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "instant-zoom",
		);
		const handheld = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "instant-zoom-handheld-long",
		);
		const focusHunt = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "instant-zoom-focus-hunt",
		);

		expect(original?.defaultDurationSeconds).toBeUndefined();
		expect(handheld?.defaultDurationSeconds).toBeGreaterThan(1);
		expect(focusHunt?.defaultDurationSeconds).toBeGreaterThan(1);
	});

	test("resolves creative visual overlay movement values", () => {
		const darken = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "darken-room-push",
		);
		const vintage = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "vintage-snap-zoom",
		);
		if (!darken) throw new Error("Missing darken room preset");
		if (!vintage) throw new Error("Missing vintage snap preset");

		const darkenFrame = resolveOverlayMovementFrame({
			effectParams: darken.params,
			localTime: 50,
			duration: 100,
			width: 1920,
			height: 1080,
		});
		const vintageFrame = resolveOverlayMovementFrame({
			effectParams: vintage.params,
			localTime: 50,
			duration: 100,
			width: 1920,
			height: 1080,
		});

		expect(darkenFrame?.overlayColor).toBe("#000000");
		expect(darkenFrame?.overlayAlpha).toBeGreaterThan(0.3);
		expect(darkenFrame?.vignetteAlpha).toBeGreaterThan(0.3);
		expect(vintageFrame?.overlayBlendMode).toBe("soft-light");
		expect(vintageFrame?.overlayAlpha).toBeGreaterThan(0.1);
	});

	test("resolves seek-safe virtual camera routes with parallax metadata", () => {
		const preset = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "camera-canvas-pan-right",
		);
		if (!preset) throw new Error("Missing virtual camera preset");

		const start = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 0,
			duration: 100,
			width: 1000,
			height: 500,
		});
		const middle = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 50,
			duration: 100,
			width: 1000,
			height: 500,
		});
		const end = resolveOverlayMovementFrame({
			effectParams: preset.params,
			localTime: 100,
			duration: 100,
			width: 1000,
			height: 500,
		});

		expect(start?.translateX).toBeCloseTo(0);
		expect(end?.translateX).toBeCloseTo(-1000);
		expect(middle?.translateX).toBeLessThan(-490);
		expect(middle?.translateX).toBeGreaterThan(-510);
		expect(end?.translateY).toBeCloseTo(0);
		expect(end?.rotate).toBeCloseTo(0);
		expect(middle?.parallaxStrength).toBeCloseTo(0.18);
	});

	test("overrides the virtual camera route with serialized camera keyframes", () => {
		const preset = OVERLAY_MOVEMENT_PRESETS.find(
			(item) => item.id === "camera-canvas-pan-right",
		);
		if (!preset) throw new Error("Missing virtual camera preset");

		const animations = {
			[PARALLAX_CAMERA_KEYFRAME_PATHS.x]: {
				keys: [
					{
						id: "start",
						time: 0,
						value: 0,
						segmentToNext: "linear" as const,
						tangentMode: "auto" as const,
					},
					{
						id: "end",
						time: 100,
						value: 0.25,
						segmentToNext: "linear" as const,
						tangentMode: "auto" as const,
					},
				],
			},
		};

		const middle = resolveOverlayMovementFrame({
			effectParams: preset.params,
			animations,
			localTime: 50,
			duration: 100,
			width: 1000,
			height: 500,
		});

		expect(middle?.translateX).toBeCloseTo(-125);
	});
});
