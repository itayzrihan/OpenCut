import { expectMigratedBundleAudio } from "../../../test-support/private-bundle-audio";
import { describe, expect, test } from "bun:test";
import {
	COUNTER_TYPING_SFX_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "counter-big",
);

describe("Counter UI element typing bundle", () => {
	test("recreates the user-authored Counter and Typing timeline pairing", () => {
		expect(preset?.defaultDurationSeconds).toBe(1.74);
		expect(preset?.bundle?.graphics).toHaveLength(1);
		expect(preset?.bundle?.audio).toHaveLength(1);
		expect(preset?.bundle?.audio[0]).toMatchObject({
			name: "Typing",
			libraryAssetId: COUNTER_TYPING_SFX_ASSET_ID,
			startOffsetSeconds: 0.09808333333333333,
			durationSeconds: 1.311416666666667,
			sourceDurationSeconds: 1.311416666666667,
			trimStartSeconds: 0,
			trimEndSeconds: 0,
			params: { volume: -9.6 },
		});
	});

	test("resolves the migrated private typing sound by stable ID", async () => {
		await expectMigratedBundleAudio([COUNTER_TYPING_SFX_ASSET_ID]);
	});
});
