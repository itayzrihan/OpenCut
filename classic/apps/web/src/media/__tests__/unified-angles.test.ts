// @opencut-test-wasm: real
import { describe, expect, test } from "bun:test";
import { mediaTime } from "@/wasm";
import type { MediaAsset } from "@/media/types";
import {
	createUnifiedAnglesAsset,
	getUnifiedAngleRange,
	unifiedAnglesSyncStatus,
	resolveUnifiedAnglesVideoTiming,
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

test("longest camera defines duration; synced angle boundaries and decoded timestamps agree", () => {
	const long = { ...video({ id: "long" }), duration: 3600, bindingRevision: 2 };
	const short = {
		...video({ id: "short" }),
		duration: 1800,
		bindingRevision: 3,
	};
	const asset: MediaAsset = {
		id: "unified",
		...createUnifiedAnglesAsset({ assets: [short, long] }),
	};
	const map = new Map([long, short, asset].map((a) => [a.id, a]));
	expect(asset.duration).toBe(3600);
	expect(asset.unifiedAngles?.defaultAngleAssetId).toBe("long");
	expect(asset.unifiedAngles?.audioAssetId).toBe("long");
	expect(unifiedAnglesSyncStatus({ asset, mediaMap: map })).toBe("unsynced");
	expect(
		getUnifiedAngleRange({
			asset,
			mediaMap: map,
			angleAssetId: "short",
			trimStart: 60,
			duration: 10,
		}).available,
	).toBe(false);
	asset.unifiedAngles!.sync = {
		method: "audio",
		referenceAssetId: "long",
		sources: [
			{ id: "long", duration: 3600, start: 0, bindingRevision: 2 },
			{ id: "short", duration: 1800, start: 30, bindingRevision: 3 },
		],
	};
	expect(unifiedAnglesSyncStatus({ asset, mediaMap: map })).toBe("synced");
	expect(
		getUnifiedAngleRange({
			asset,
			mediaMap: map,
			angleAssetId: "short",
			trimStart: 29,
			duration: 2,
		}).available,
	).toBe(false);
	expect(
		getUnifiedAngleRange({
			asset,
			mediaMap: map,
			angleAssetId: "short",
			trimStart: 30,
			duration: 1800,
		}).available,
	).toBe(true);
	expect(
		getUnifiedAngleRange({
			asset,
			mediaMap: map,
			angleAssetId: "short",
			trimStart: 1829,
			duration: 2,
		}).available,
	).toBe(false);
	const element = {
		id: "clip",
		type: "video" as const,
		mediaId: "unified",
		unifiedAngleId: "short",
		name: "Test",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 1200000 }),
		trimStart: mediaTime({ ticks: 7200000 }),
		trimEnd: mediaTime({ ticks: (3600 - 70) * 120000 }),
		sourceDuration: mediaTime({ ticks: 3600 * 120000 }),
		params: {},
	};
	const timing = resolveUnifiedAnglesVideoTiming({
		asset,
		mediaMap: map,
		element,
	});
	expect(timing?.asset.id).toBe("short");
	expect(timing?.trimStart).toBe(30 * 120000);
	map.set("short", { ...short, bindingRevision: 4 });
	expect(unifiedAnglesSyncStatus({ asset, mediaMap: map })).toBe("stale");
	expect(
		resolveUnifiedAnglesVideoTiming({ asset, mediaMap: map, element })?.asset
			.id,
	).toBe("long");
});
