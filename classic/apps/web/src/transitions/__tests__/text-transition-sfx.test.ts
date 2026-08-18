import { describe, expect, test } from "bun:test";
import {
	getTextTransitionSfxPreset,
	hasTextTransitionSfx,
} from "@/transitions/text-transition-sfx-presets";

describe("text transition companion SFX", () => {
	test("only the requested transitions advertise audio", () => {
		expect(hasTextTransitionSfx({ transitionId: "push-right" })).toBe(true);
		expect(hasTextTransitionSfx({ transitionId: "slide-up" })).toBe(true);
		expect(hasTextTransitionSfx({ transitionId: "pop" })).toBe(true);
		expect(hasTextTransitionSfx({ transitionId: "grow" })).toBe(true);
		expect(hasTextTransitionSfx({ transitionId: "grow", side: "out" })).toBe(
			true,
		);
		expect(hasTextTransitionSfx({ transitionId: "grow", side: "in" })).toBe(
			false,
		);
		expect(hasTextTransitionSfx({ transitionId: "fade" })).toBe(false);
	});

	test("keeps stable library IDs and the authored trims", () => {
		expect(
			getTextTransitionSfxPreset({ transitionId: "push-right" }),
		).toMatchObject({
			assetId: "19f29ed9-a604-4933-ae8c-e494b6cee47f",
			durationSeconds: 1.38,
			sourceDurationSeconds: 8.04,
			trimEndSeconds: 6.66,
			volume: -12.3,
		});
		expect(getTextTransitionSfxPreset({ transitionId: "pop" })).toMatchObject({
			assetId: "49fd6fc0-53c5-4536-8370-ba27bb19ffcf",
			durationSeconds: 1.729375,
			trimEndSeconds: 0,
			volume: -21.9,
		});
		expect(getTextTransitionSfxPreset({ transitionId: "grow" })).toMatchObject({
			assetId: "748324d3-6e31-4bff-92a2-843ea2e20127",
			side: "out",
			leadInSeconds: 0.186225,
			durationSeconds: 1,
			sourceDurationSeconds: 5.88,
			trimStartSeconds: 0.36,
			trimEndSeconds: 4.52,
			volume: 0,
		});
	});
});
