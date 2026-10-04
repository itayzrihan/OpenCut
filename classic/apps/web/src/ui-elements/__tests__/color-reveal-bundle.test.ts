import { expectMigratedBundleAudio } from "../../../test-support/private-bundle-audio";
import { describe, expect, test } from "bun:test";
import {
	COLOR_REVEAL_WHOOSH_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "color-reveal-whoosh",
);

describe("color reveal + whoosh UI element bundle", () => {
	test("stores the three timeline clips with their exact timing", () => {
		expect(preset).toBeDefined();
		expect(preset?.bundle).toBeDefined();
		if (!preset?.bundle) return;

		expect(preset.bundle.graphics).toHaveLength(2);
		for (const graphic of preset.bundle.graphics) {
			expect(graphic.startOffsetSeconds).toBe(0);
			expect(graphic.durationSeconds).toBe(3);
			expect(graphic.definitionId).toBe("hyperframe");
		}

		expect(preset.bundle.audio).toHaveLength(1);
		const audio = preset.bundle.audio[0];
		expect(audio?.startOffsetSeconds).toBe(0.88);
		expect(audio?.durationSeconds).toBe(2);
		expect(audio?.sourceDurationSeconds).toBe(8.04);
		expect(audio?.trimStartSeconds).toBe(0);
		expect(audio?.trimEndSeconds).toBe(6.04);
		expect(audio?.libraryAssetId).toBe(COLOR_REVEAL_WHOOSH_ASSET_ID);
	});

	test("resolves the migrated whoosh only in the owning account", async () => {
		await expectMigratedBundleAudio([COLOR_REVEAL_WHOOSH_ASSET_ID]);
	});
});
