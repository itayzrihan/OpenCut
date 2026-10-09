import { expectMigratedBundleAudio } from "../../../test-support/private-bundle-audio";
import { describe, expect, test } from "bun:test";
import { getUiElementAnimationOptions } from "@/ui-elements/animation-options";
import {
	CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "rtl-cancellation-checklist-sfx",
);

describe("RTL cancellation checklist UI element", () => {
	test("keeps transcript timing, RTL layout, red event, and stationary exit", () => {
		expect(preset).toBeDefined();
		expect(preset?.defaultDurationSeconds).toBe(5.625);
		expect(preset?.params).toMatchObject({
			items: "יש לו כסף\nקנו אותו\nעשו לו",
			textDirection: "rtl",
			listTextAlign: "right",
			itemStartPoints: "0,26.19,36.68",
			eventAt: 79.38,
			eventBackgroundEnabled: true,
			eventBackground: "#D92D20",
			animationOutStart: 91.64,
			animationOut: "list-blur-zoom-fade",
		});
		expect(
			getUiElementAnimationOptions({
				template: "checkbox-list",
				side: "out",
			}),
		).toContainEqual({
			value: "list-blur-zoom-fade",
			label: "Blur + zoom fade (stationary)",
		});
	});

	test("bundles the cancellation sound at the exit beat and preserves private access", async () => {
		expect(preset?.bundle?.graphics).toHaveLength(1);
		expect(preset?.bundle?.audio).toHaveLength(1);
		expect(preset?.bundle?.audio[0]).toMatchObject({
			libraryAssetId: CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
			startOffsetSeconds: 4.745,
			durationSeconds: 1.985281,
		});

		await expectMigratedBundleAudio([CANCELLATION_CHECKLIST_GLITCH_ASSET_ID]);
	});
});
