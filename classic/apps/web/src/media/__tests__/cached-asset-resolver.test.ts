import { describe, expect, test } from "bun:test";
import { createCachedAssetResolver } from "../cached-asset-resolver";

describe("createCachedAssetResolver", () => {
	test("resolves one source once when many timeline cuts share it", async () => {
		let decodeCount = 0;
		const resolve = createCachedAssetResolver({
			resolve: async ({ asset }: { asset: { id: string } }) => {
				decodeCount += 1;
				return `decoded:${asset.id}`;
			},
		});
		const sharedSource = { id: "shared-video-source" };

		const decodedCuts = await Promise.all(
			Array.from({ length: 40 }, () => resolve({ asset: sharedSource })),
		);

		expect(decodeCount).toBe(1);
		expect(decodedCuts).toHaveLength(40);
		expect(new Set(decodedCuts)).toEqual(
			new Set(["decoded:shared-video-source"]),
		);
	});

	test("keeps different source files independent", async () => {
		let decodeCount = 0;
		const resolve = createCachedAssetResolver({
			resolve: async ({ asset }: { asset: { id: string } }) => {
				decodeCount += 1;
				return asset.id;
			},
		});

		const decoded = await Promise.all([
			resolve({ asset: { id: "source-a" } }),
			resolve({ asset: { id: "source-b" } }),
		]);

		expect(decodeCount).toBe(2);
		expect(decoded).toEqual(["source-a", "source-b"]);
	});
});
