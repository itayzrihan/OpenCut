import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import { createUnifiedAnglesAsset } from "@/media/unified-angles";
import {
	buildUnifiedAngleCycleUpdates,
	buildUnifiedAngleSetUpdates,
} from "@/timeline/unified-angles-cycle";
import { mediaTime, type MediaTime } from "@/wasm";

function video(id: string): MediaAsset {
	return {
		id,
		name: `Camera ${id}`,
		type: "video",
		duration: 20,
		hasAudio: true,
		url: `blob:${id}`,
	};
}

function time(value: number): MediaTime {
	return mediaTime({ ticks: value });
}

describe("Unified Angles cycling", () => {
	test("sets every selected cut to the same chosen angle", () => {
		const angles = [video("one"), video("two")];
		const asset: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: angles }),
		};
		const updates = buildUnifiedAngleSetUpdates({
			asset,
			angleAssetId: "two",
			targets: [0, 1, 2].map((startTime) => ({
				trackId: "main",
				elementId: `cut-${startTime}`,
				mediaId: asset.id,
				startTime: time(startTime),
				trackOrder: 0,
			})),
		});

		expect(updates.map((update) => update.patch.unifiedAngleId)).toEqual([
			"two",
			"two",
			"two",
		]);
	});

	test("orders cuts chronologically and alternates from the chosen first angle", () => {
		const angles = [video("one"), video("two")];
		const asset: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: angles }),
		};

		const updates = buildUnifiedAngleCycleUpdates({
			asset,
			startingAngleAssetId: "two",
			targets: [
				{
					trackId: "main",
					elementId: "cut-3",
					mediaId: asset.id,
					startTime: time(20),
					trackOrder: 0,
				},
				{
					trackId: "main",
					elementId: "cut-1",
					mediaId: asset.id,
					startTime: time(0),
					trackOrder: 0,
				},
				{
					trackId: "main",
					elementId: "cut-2",
					mediaId: asset.id,
					startTime: time(10),
					trackOrder: 0,
				},
			],
		});

		expect(updates.map((update) => update.elementId)).toEqual([
			"cut-1",
			"cut-2",
			"cut-3",
		]);
		expect(updates.map((update) => update.patch.unifiedAngleId)).toEqual([
			"two",
			"one",
			"two",
		]);
	});

	test("cycles through every angle for a three-camera Unified asset", () => {
		const angles = [video("one"), video("two"), video("three")];
		const asset: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: angles }),
		};
		const updates = buildUnifiedAngleCycleUpdates({
			asset,
			startingAngleAssetId: "two",
			targets: [0, 1, 2, 3].map((startTime) => ({
				trackId: "main",
				elementId: `cut-${startTime}`,
				mediaId: asset.id,
				startTime: time(startTime),
				trackOrder: 0,
			})),
		});

		expect(updates.map((update) => update.patch.unifiedAngleId)).toEqual([
			"two",
			"three",
			"one",
			"two",
		]);
	});

	test("rejects a mixed Unified Angles selection", () => {
		const angles = [video("one"), video("two")];
		const asset: MediaAsset = {
			id: "unified",
			...createUnifiedAnglesAsset({ assets: angles }),
		};

		expect(() =>
			buildUnifiedAngleCycleUpdates({
				asset,
				startingAngleAssetId: "one",
				targets: [
					{
						trackId: "main",
						elementId: "cut-1",
						mediaId: asset.id,
						startTime: time(0),
						trackOrder: 0,
					},
					{
						trackId: "main",
						elementId: "cut-2",
						mediaId: "another-unified",
						startTime: time(1),
						trackOrder: 0,
					},
				],
			}),
		).toThrow("same Unified Angles asset");
	});
});
