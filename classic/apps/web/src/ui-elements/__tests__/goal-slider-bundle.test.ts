import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SharedLibraryManifest } from "@/shared-library/types";
import {
	GOAL_SLIDER_IN_SFX_ASSET_ID,
	GOAL_SLIDER_OUT_SFX_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "product-goal",
);

function readManifest(): SharedLibraryManifest {
	const manifestPath = fileURLToPath(
		new URL("../../../public/shared-library/manifest.json", import.meta.url),
	);
	return JSON.parse(readFileSync(manifestPath, "utf8"));
}

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

	test("both referenced sound files remain resolvable after metadata renames", () => {
		const manifest = readManifest();
		for (const assetId of [
			GOAL_SLIDER_IN_SFX_ASSET_ID,
			GOAL_SLIDER_OUT_SFX_ASSET_ID,
		]) {
			const asset = manifest.audioAssets.find((item) => item.id === assetId);
			expect(asset?.repositoryPath).toBeTruthy();
			if (!asset?.repositoryPath) continue;
			const audioPath = fileURLToPath(
				new URL(`../../../${asset.repositoryPath}`, import.meta.url),
			);
			expect(existsSync(audioPath)).toBe(true);
		}
	});
});
