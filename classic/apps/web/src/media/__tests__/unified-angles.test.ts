import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import {
	createUnifiedAnglesAsset,
	resolveUnifiedAnglesAudioAsset,
	resolveUnifiedAnglesVideoAsset,
} from "@/media/unified-angles";

function video({
	id,
	hasAudio = true,
}: {
	id: string;
	hasAudio?: boolean;
}): MediaAsset {
	return {
		id,
		name: `Camera ${id}`,
		type: "video",
		size: 100,
		lastModified: 1,
		duration: 30,
		width: 1920,
		height: 1080,
		fps: 30,
		hasAudio,
		url: `blob:${id}`,
	};
}

describe("Unified Angles", () => {
	test("keeps video switching independent from the one chosen audio source", () => {
		const first = video({ id: "one" });
		const second = video({ id: "two" });
		const virtual: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: [first, second] }),
		};
		const mediaMap = new Map(
			[first, second, virtual].map((asset) => [asset.id, asset]),
		);

		expect(
			resolveUnifiedAnglesVideoAsset({
				asset: virtual,
				angleAssetId: "two",
				mediaMap,
			})?.id,
		).toBe("two");
		expect(
			resolveUnifiedAnglesAudioAsset({ asset: virtual, mediaMap })?.id,
		).toBe("one");
	});

	test("supports three or more angles", () => {
		const unified = createUnifiedAnglesAsset({
			assets: [
				video({ id: "one" }),
				video({ id: "two" }),
				video({ id: "three" }),
			],
		});
		expect(unified.unifiedAngles?.angleAssetIds).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	test("rejects selections with fewer than two videos", () => {
		expect(() =>
			createUnifiedAnglesAsset({ assets: [video({ id: "one" })] }),
		).toThrow("at least two");
	});
});
