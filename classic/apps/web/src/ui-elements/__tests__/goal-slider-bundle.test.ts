import { expectMigratedBundleAudio } from "../../../test-support/private-bundle-audio";
import { describe, expect, test } from "bun:test";
import {
	GOAL_SLIDER_IN_SFX_ASSET_ID,
	GOAL_SLIDER_OUT_SFX_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "product-goal",
);

describe("Goal Slider UI element bundle", () => {
	test("recreates the live in/out sound timing and trims by stable asset id", () => {
		expect(preset?.defaultDurationSeconds).toBe(3.06);
		expect(preset?.bundle?.graphics).toHaveLength(1);
		expect(preset?.bundle?.audio).toHaveLength(2);
		expect(preset?.bundle?.audio[0]).toMatchObject({
			libraryAssetId: GOAL_SLIDER_IN_SFX_ASSET_ID,
			startOffsetSeconds: 0,
			durationSeconds: 1.536,
			sourceDurationSeconds: 1.536,
			trimStartSeconds: 0,
			trimEndSeconds: 0,
			params: { volume: -8.9 },
		});
		expect(preset?.bundle?.audio[1]).toMatchObject({
			libraryAssetId: GOAL_SLIDER_OUT_SFX_ASSET_ID,
			startOffsetSeconds: 1.798275,
			durationSeconds: 1.26,
			sourceDurationSeconds: 5.88,
			trimStartSeconds: 0,
			trimEndSeconds: 4.62,
			params: { volume: -8.9 },
		});
	});

	test("resolves both migrated private sounds after metadata renames", async () => {
		await expectMigratedBundleAudio([GOAL_SLIDER_IN_SFX_ASSET_ID, GOAL_SLIDER_OUT_SFX_ASSET_ID]);
	});
});
