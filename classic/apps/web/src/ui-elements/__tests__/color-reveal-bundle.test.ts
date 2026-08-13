import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	COLOR_REVEAL_WHOOSH_ASSET_ID,
	UI_ELEMENT_PRESETS,
} from "@/ui-elements/catalog";
import type { SharedLibraryManifest } from "@/shared-library/types";

const preset = UI_ELEMENT_PRESETS.find(
	(candidate) => candidate.id === "color-reveal-whoosh",
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

	test("ships the referenced sound in the repository shared library", () => {
		const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
		const manifestPath = fileURLToPath(
			new URL("../../../public/shared-library/manifest.json", import.meta.url),
		);
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		expect(isSharedLibraryManifest(parsed)).toBe(true);
		if (!isSharedLibraryManifest(parsed)) return;
		const manifest = parsed;
		const asset = manifest.audioAssets.find(
			(candidate) => candidate.id === COLOR_REVEAL_WHOOSH_ASSET_ID,
		);

		expect(asset).toBeDefined();
		expect(asset?.storageKind).toBe("repo");
		expect(asset?.name).toBe("soundreality-whoosh-end-384629");
		expect(asset?.repositoryPath).toBe(
			`public/shared-library/audio/sfx/${COLOR_REVEAL_WHOOSH_ASSET_ID}.mp3`,
		);
		if (!asset?.repositoryPath) return;

		const audioPath = fileURLToPath(
			new URL(`../../../${asset.repositoryPath}`, import.meta.url),
		);
		expect(audioPath.startsWith(webRoot)).toBe(true);
		expect(existsSync(audioPath)).toBe(true);
		expect(statSync(audioPath).size).toBeGreaterThan(0);
	});
});
