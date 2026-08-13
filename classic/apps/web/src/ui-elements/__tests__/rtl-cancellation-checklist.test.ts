import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SharedLibraryManifest } from "@/shared-library/types";
import { getUiElementAnimationOptions } from "@/ui-elements/animation-options";
import {
	CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "rtl-cancellation-checklist-sfx",
);

function isSharedLibraryManifest(
	value: unknown,
): value is SharedLibraryManifest {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray(Reflect.get(value, "audioAssets"))
	);
}

function readManifest(): SharedLibraryManifest | null {
	const manifestPath = fileURLToPath(
		new URL("../../../public/shared-library/manifest.json", import.meta.url),
	);
	const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	return isSharedLibraryManifest(parsed) ? parsed : null;
}

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

	test("bundles the cancellation sound at the exit beat", () => {
		expect(preset?.bundle?.graphics).toHaveLength(1);
		expect(preset?.bundle?.audio).toHaveLength(1);
		expect(preset?.bundle?.audio[0]).toMatchObject({
			libraryAssetId: CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
			startOffsetSeconds: 4.745,
			durationSeconds: 1.985281,
		});

		const asset = readManifest()?.audioAssets.find(
			(candidate) =>
				candidate.id === CANCELLATION_CHECKLIST_GLITCH_ASSET_ID,
		);
		expect(asset?.name).toBe("alexzavesa-woosh-glitch-1-463012");
		expect(asset?.repositoryPath).toBeTruthy();
		if (!asset?.repositoryPath) return;
		const audioPath = fileURLToPath(
			new URL(`../../../${asset.repositoryPath}`, import.meta.url),
		);
		expect(existsSync(audioPath)).toBe(true);
		expect(statSync(audioPath).size).toBeGreaterThan(0);
	});
});
