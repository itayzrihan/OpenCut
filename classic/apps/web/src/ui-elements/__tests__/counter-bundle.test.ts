import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SharedLibraryManifest } from "@/shared-library/types";
import {
	COUNTER_TYPING_SFX_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "counter-big",
);

function readManifest(): SharedLibraryManifest {
	const manifestPath = fileURLToPath(
		new URL("../../../public/shared-library/manifest.json", import.meta.url),
	);
	return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("Counter UI element typing bundle", () => {
	test("recreates the user-authored Counter and Typing timeline pairing", () => {
		expect(preset?.defaultDurationSeconds).toBe(1.74);
		expect(preset?.bundle?.graphics).toHaveLength(1);
		expect(preset?.bundle?.audio).toHaveLength(1);
		expect(preset?.bundle?.audio[0]).toMatchObject({
			name: "Typing",
			libraryAssetId: COUNTER_TYPING_SFX_ASSET_ID,
			startOffsetSeconds: 0.09808333333333333,
			durationSeconds: 1.3114166666666668,
			sourceDurationSeconds: 1.3114166666666668,
			trimStartSeconds: 0,
			trimEndSeconds: 0,
			params: { volume: -9.6 },
		});
	});

	test("keeps the typing sound resolvable by stable library ID", () => {
		const asset = readManifest().audioAssets.find(
			(item) => item.id === COUNTER_TYPING_SFX_ASSET_ID,
		);
		expect(asset?.repositoryPath).toBeTruthy();
		if (!asset?.repositoryPath) return;
		const audioPath = fileURLToPath(
			new URL(`../../../${asset.repositoryPath}`, import.meta.url),
		);
		expect(existsSync(audioPath)).toBe(true);
	});
});
