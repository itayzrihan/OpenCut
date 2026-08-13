/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Browser API doubles intentionally mirror native constructor signatures. */
import { describe, expect, test } from "bun:test";
import type { ResolvedBackgroundRemovalSettings } from "@/background-removal";
import {
	PREPARED_MASK_SCHEMA_VERSION,
	type PersistedPreparedMaskFrame,
	type PreparedMaskManifest,
	type PreparedMaskPersistence,
} from "@/services/background-removal/prepared-mask-persistence";
import { BackgroundRemovalService } from "@/services/background-removal/service";

const SETTINGS: ResolvedBackgroundRemovalSettings = {
	enabled: true,
	mode: "remove",
	quality: "precise",
	maskThreshold: 0.5,
	edgeContrast: 1,
	edgeFeather: 0,
	temporalSmoothing: 0.24,
	blurStrength: 0.55,
	inputSize: 512,
	previewFps: 25,
	cacheEntries: 72,
	blurSigma: 12,
};

function installMaskCanvasDoubles(): () => void {
	const originalOffscreenCanvas = globalThis.OffscreenCanvas;
	const originalImageData = globalThis.ImageData;
	class FakeOffscreenCanvas {
		readonly width: number;
		readonly height: number;
		private readonly context = {
			filter: "none",
			putImageData: () => undefined,
			clearRect: () => undefined,
			drawImage: () => undefined,
		};

		constructor(width: number, height: number) {
			this.width = width;
			this.height = height;
		}

		getContext() {
			return this.context;
		}
	}
	class FakeImageData {
		constructor(
			readonly data: Uint8ClampedArray,
			readonly width: number,
			readonly height: number,
		) {}
	}
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: FakeOffscreenCanvas,
	});
	Object.defineProperty(globalThis, "ImageData", {
		configurable: true,
		value: FakeImageData,
	});
	return () => {
		if (originalOffscreenCanvas === undefined) {
			Reflect.deleteProperty(globalThis, "OffscreenCanvas");
		} else {
			Object.defineProperty(globalThis, "OffscreenCanvas", {
				configurable: true,
				value: originalOffscreenCanvas,
			});
		}
		if (originalImageData === undefined) {
			Reflect.deleteProperty(globalThis, "ImageData");
		} else {
			Object.defineProperty(globalThis, "ImageData", {
				configurable: true,
				value: originalImageData,
			});
		}
	};
}

class MemoryPreparedMaskPersistence implements PreparedMaskPersistence {
	readonly manifests = new Map<string, PreparedMaskManifest>();
	readonly frames = new Map<string, PersistedPreparedMaskFrame>();
	readonly frameGroupKeys = new Set<string>();
	readonly deleteCalls: string[] = [];
	failPutManifest = false;

	async listGroupKeys(): Promise<string[]> {
		return [...new Set([...this.manifests.keys(), ...this.frameGroupKeys])];
	}

	async listManifests(): Promise<PreparedMaskManifest[]> {
		return [...this.manifests.values()];
	}

	async getManifest(groupKey: string): Promise<PreparedMaskManifest | null> {
		return this.manifests.get(groupKey) ?? null;
	}

	async getFrame({
		groupKey,
		inferenceKey,
	}: {
		groupKey: string;
		inferenceKey: string;
	}): Promise<PersistedPreparedMaskFrame | null> {
		const frame = this.frames.get(`${groupKey}:${inferenceKey}`);
		return frame ? { ...frame, alpha: frame.alpha.slice() } : null;
	}

	async putFrame({
		manifest,
		frame,
	}: {
		manifest: PreparedMaskManifest;
		frame: PersistedPreparedMaskFrame;
	}): Promise<void> {
		this.manifests.set(manifest.groupKey, manifest);
		this.frameGroupKeys.add(manifest.groupKey);
		this.frames.set(`${manifest.groupKey}:${frame.inferenceKey}`, {
			...frame,
			alpha: frame.alpha.slice(),
		});
	}

	async putManifest(manifest: PreparedMaskManifest): Promise<void> {
		if (this.failPutManifest) throw new Error("Temporary quota failure");
		this.manifests.set(manifest.groupKey, manifest);
	}

	async deleteGroup(groupKey: string): Promise<void> {
		this.deleteCalls.push(groupKey);
		this.manifests.delete(groupKey);
		this.frameGroupKeys.delete(groupKey);
		for (const key of this.frames.keys()) {
			if (key.startsWith(`${groupKey}:`)) this.frames.delete(key);
		}
	}

	seed({
		groupKey,
		lastUsed,
		frameSizes,
		inferenceKeys,
	}: {
		groupKey: string;
		lastUsed: number;
		frameSizes: number[];
		inferenceKeys?: string[];
	}) {
		const frames = frameSizes.map((byteLength, index) => {
			const inferenceKey = inferenceKeys?.[index] ?? `frame-${index}`;
			const frame = {
				inferenceKey,
				width: byteLength,
				height: 1,
				contentHash: `${groupKey}-${index}`,
				byteLength,
				alpha: new Uint8Array(byteLength).fill(index + 1),
			} satisfies PersistedPreparedMaskFrame;
			this.frameGroupKeys.add(groupKey);
			this.frames.set(`${groupKey}:${inferenceKey}`, frame);
			return {
				inferenceKey,
				width: frame.width,
				height: frame.height,
				contentHash: frame.contentHash,
				byteLength,
			};
		});
		this.manifests.set(groupKey, {
			schemaVersion: PREPARED_MASK_SCHEMA_VERSION,
			groupKey,
			lastUsed,
			complete: true,
			expectedInferenceKeys: frames.map((frame) => frame.inferenceKey),
			totalByteSize: frameSizes.reduce((total, size) => total + size, 0),
			frames,
		});
	}
}

describe("prepared matte persistence", () => {
	test("keeps prepared render-cache entries isolated by matte group", async () => {
		const restoreCanvasGlobals = installMaskCanvasDoubles();
		try {
			const persistence = new MemoryPreparedMaskPersistence();
			const service = new BackgroundRemovalService({
				autoHydrate: false,
				persistence,
				maxPreparedAlphaBytes: 16,
			});
			const inferenceKey = service.getPreparedInferenceKey({
				mediaId: "shared-video",
				sourceTime: 1,
				settings: SETTINGS,
			});
			persistence.seed({
				groupKey: "group-a",
				lastUsed: 2,
				frameSizes: [2],
				inferenceKeys: [inferenceKey],
			});
			persistence.seed({
				groupKey: "group-b",
				lastUsed: 1,
				frameSizes: [2],
				inferenceKeys: [inferenceKey],
			});
			await service.hydratePreparedGroups();
			await service.hydratePreparedGroup({ groupKey: "group-b" });

			const groupA = service.getPreparedMaskFrame({
				groupKey: "group-a",
				mediaId: "shared-video",
				sourceTime: 1,
				settings: SETTINGS,
			});
			const groupB = service.getPreparedMaskFrame({
				groupKey: "group-b",
				mediaId: "shared-video",
				sourceTime: 1,
				settings: SETTINGS,
			});

			expect(groupA?.contentHash).toBe("group-a-0:feather=0.00");
			expect(groupB?.contentHash).toBe("group-b-0:feather=0.00");
			expect(groupB).not.toBe(groupA);
		} finally {
			restoreCanvasGlobals();
		}
	});

	test("hydrates a complete manifest and its alpha chunks after a service reload", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "matte-cache-key",
			lastUsed: 10,
			frameSizes: [2, 3],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 16,
		});

		await service.hydratePreparedGroups();

		expect(
			service.getPreparedGroupFrameCount({
				groupKey: "matte-cache-key",
			}),
		).toBe(2);
		expect(
			service.isPreparedGroupComplete({
				groupKey: "matte-cache-key",
			}),
		).toBe(true);
		expect(service.getPreparedMemoryUsage().bytes).toBe(5);
		expect(
			service.isPreparedGroupComplete({
				groupKey: "matte-cache-key",
				expectedInferenceKeys: ["wrong-key"],
			}),
		).toBe(false);
	});

	test("prunes the oldest manifest and alpha chunks from persistence under the byte cap", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "older",
			lastUsed: 1,
			frameSizes: [4],
		});
		persistence.seed({
			groupKey: "newer",
			lastUsed: 2,
			frameSizes: [4],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 6,
		});

		await service.hydratePreparedGroups();
		expect(service.isPreparedGroupComplete({ groupKey: "newer" })).toBe(true);
		expect(await service.hydratePreparedGroup({ groupKey: "older" })).toBe(
			false,
		);
		expect(service.isPreparedGroupComplete({ groupKey: "older" })).toBe(false);
		expect(service.hasPreparedGroup({ groupKey: "newer" })).toBe(true);
		expect(service.getPreparedMemoryUsage().bytes).toBeLessThanOrEqual(6);
		expect(service.getPreparedMemoryUsage().reservedBytes).toBe(0);
		expect(persistence.deleteCalls).toEqual(["older"]);
		expect(persistence.manifests.has("older")).toBe(false);
		expect(
			[...persistence.frames.keys()].some((key) => key.startsWith("older:")),
		).toBe(false);
		expect(
			[...persistence.manifests.values()].reduce(
				(total, manifest) => total + manifest.totalByteSize,
				0,
			),
		).toBeLessThanOrEqual(6);
	});

	test("runtime LRU eviction deletes the old group before persisting a new group", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "old-runtime-group",
			lastUsed: 1,
			frameSizes: [2],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedGroups: 1,
			maxPreparedAlphaBytes: 16,
		});
		await service.hydratePreparedGroups();
		const inferenceKey = service.getPreparedInferenceKey({
			mediaId: "new-video",
			sourceTime: 1,
			settings: SETTINGS,
		});
		Object.assign(service, {
			getOrRunSegmentation: async () => ({
				alpha: new Uint8Array([255, 128]),
				width: 2,
				height: 1,
				contentHash: "new-runtime-group",
			}),
		});

		await service.prepareMaskFrame({
			groupKey: "new-runtime-group",
			source: {} as CanvasImageSource,
			mediaId: "new-video",
			sourceTime: 1,
			settings: SETTINGS,
		});
		service.markPreparedGroupComplete({
			groupKey: "new-runtime-group",
			expectedInferenceKeys: [inferenceKey],
		});
		await service.flushPreparedMaskPersistence({
			groupKey: "new-runtime-group",
		});

		expect(persistence.deleteCalls).toContain("old-runtime-group");
		expect(persistence.manifests.has("old-runtime-group")).toBe(false);
		expect(
			[...persistence.frames.keys()].some((key) =>
				key.startsWith("old-runtime-group:"),
			),
		).toBe(false);
		expect(persistence.manifests.has("new-runtime-group")).toBe(true);
		expect(persistence.manifests.size).toBe(1);
	});

	test("never hydrates an oversized group past the configured cap", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "oversized",
			lastUsed: 1,
			frameSizes: [4, 4],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 6,
		});

		await service.hydratePreparedGroups();

		expect(service.isPreparedGroupComplete({ groupKey: "oversized" })).toBe(
			false,
		);
		expect(service.getPreparedMemoryUsage().bytes).toBe(0);
		expect(service.getPreparedMemoryUsage().reservedBytes).toBe(0);
		expect(persistence.deleteCalls).toEqual(["oversized"]);
		expect(persistence.manifests.size).toBe(0);
		expect(persistence.frames.size).toBe(0);
	});

	test("durability flush fails instead of reporting success without IndexedDB", async () => {
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence: null,
		});

		await expect(
			service.flushPreparedMaskPersistence({ groupKey: "unavailable" }),
		).rejects.toThrow("Persistent prepared matte storage is unavailable");
	});

	test("reapply regenerates a manifest entry whose alpha chunk is missing", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 16,
		});
		const inferenceKey = service.getPreparedInferenceKey({
			mediaId: "video",
			sourceTime: 1,
			settings: SETTINGS,
		});
		persistence.manifests.set("recoverable", {
			schemaVersion: PREPARED_MASK_SCHEMA_VERSION,
			groupKey: "recoverable",
			lastUsed: 1,
			complete: true,
			expectedInferenceKeys: [inferenceKey],
			totalByteSize: 2,
			frames: [
				{
					inferenceKey,
					width: 2,
					height: 1,
					contentHash: "missing",
					byteLength: 2,
				},
			],
		});
		Object.assign(service, {
			getOrRunSegmentation: async () => ({
				alpha: new Uint8Array([255, 128]),
				width: 2,
				height: 1,
				contentHash: "regenerated",
			}),
		});

		await service.prepareMaskFrame({
			groupKey: "recoverable",
			source: {} as CanvasImageSource,
			mediaId: "video",
			sourceTime: 1,
			settings: SETTINGS,
		});
		service.markPreparedGroupComplete({
			groupKey: "recoverable",
			expectedInferenceKeys: [inferenceKey],
		});
		await service.flushPreparedMaskPersistence({ groupKey: "recoverable" });

		expect(
			service.isPreparedGroupComplete({
				groupKey: "recoverable",
				expectedInferenceKeys: [inferenceKey],
			}),
		).toBe(true);
		expect(
			await persistence.getFrame({
				groupKey: "recoverable",
				inferenceKey,
			}),
		).not.toBeNull();
	});

	test("a transient write failure can be retried by resetting that group", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "retryable",
			lastUsed: 1,
			frameSizes: [2],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 16,
		});
		await service.hydratePreparedGroups();
		persistence.failPutManifest = true;
		service.markPreparedGroupComplete({
			groupKey: "retryable",
			expectedInferenceKeys: ["frame-0"],
		});
		await expect(
			service.flushPreparedMaskPersistence({ groupKey: "retryable" }),
		).rejects.toThrow("Temporary quota failure");

		persistence.failPutManifest = false;
		const result = await service.preparePreparedGroupApply({
			groupKey: "retryable",
			expectedInferenceKeys: ["frame-0"],
			temporalSmoothing: SETTINGS.temporalSmoothing,
		});
		await service.flushPreparedMaskPersistence({ groupKey: "retryable" });

		expect(result.reusable).toBe(false);
		expect(service.hasPreparedGroup({ groupKey: "retryable" })).toBe(false);
	});

	test("a partial temporal group is discarded before deterministic resume", async () => {
		const persistence = new MemoryPreparedMaskPersistence();
		persistence.seed({
			groupKey: "partial-temporal",
			lastUsed: 1,
			frameSizes: [2],
		});
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence,
			maxPreparedAlphaBytes: 16,
		});
		await service.hydratePreparedGroups();

		const result = await service.preparePreparedGroupApply({
			groupKey: "partial-temporal",
			expectedInferenceKeys: ["frame-0", "frame-1"],
			temporalSmoothing: SETTINGS.temporalSmoothing,
		});

		expect(result.reusable).toBe(false);
		expect(service.hasPreparedGroup({ groupKey: "partial-temporal" })).toBe(
			false,
		);
		expect(await persistence.getManifest("partial-temporal")).toBeNull();
	});
});
