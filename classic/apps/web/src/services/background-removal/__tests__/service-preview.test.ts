import { describe, expect, test } from "bun:test";
import type { ResolvedBackgroundRemovalSettings } from "@/background-removal";
import {
	BackgroundRemovalService,
	type BackgroundMaskFrame,
} from "@/services/background-removal/service";

const SETTINGS: ResolvedBackgroundRemovalSettings = {
	enabled: true,
	mode: "remove",
	quality: "precise",
	maskThreshold: 0.5,
	edgeContrast: 1,
	edgeFeather: 0.5,
	temporalSmoothing: 0.24,
	blurStrength: 0.55,
	inputSize: 512,
	previewFps: 25,
	cacheEntries: 72,
	blurSigma: 12,
};

describe("BackgroundRemovalService preview scheduling", () => {
	test("returns immediately and only reuses a time-adjacent completed mask", async () => {
		const service = new BackgroundRemovalService({
			autoHydrate: false,
			persistence: null,
			previewMaxReuseGapSeconds: 0.12,
		});
		const firstMask = {
			// Bun does not expose the browser's OffscreenCanvas in this unit test.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			canvas: {} as OffscreenCanvas,
			width: 512,
			height: 910,
			contentHash: "first-mask",
		} satisfies BackgroundMaskFrame;
		const invalidations: number[] = [];
		service.subscribeMaskInvalidation((invalidation) => {
			if (invalidation.kind === "preview") {
				invalidations.push(invalidation.sourceTime);
			}
		});
		let resolveFirst: (frame: BackgroundMaskFrame) => void = () => undefined;
		const firstResult = new Promise<BackgroundMaskFrame>((resolve) => {
			resolveFirst = resolve;
		});
		let calls = 0;
		service.segmentFrame = async () => {
			calls += 1;
			return firstResult;
		};

		// The scheduled method is mocked, so no browser API reads this placeholder.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		const source = {} as CanvasImageSource;
		const initial = service.getPreviewMaskOrSchedule({
			source,
			mediaId: "video",
			sourceTime: 1,
			settings: SETTINGS,
		});
		const coalesced = service.getPreviewMaskOrSchedule({
			source,
			mediaId: "video",
			sourceTime: 1.04,
			settings: SETTINGS,
		});

		expect(initial).toBeNull();
		expect(coalesced).toBeNull();
		expect(calls).toBe(1);

		resolveFirst(firstMask);
		await firstResult;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		const latest = service.getPreviewMaskOrSchedule({
			source,
			mediaId: "video",
			sourceTime: 1.08,
			settings: SETTINGS,
		});

		expect(latest).toBe(firstMask);
		expect(calls).toBe(2);

		const distantWhilePending = service.getPreviewMaskOrSchedule({
			source,
			mediaId: "video",
			sourceTime: 2,
			settings: SETTINGS,
		});
		expect(distantWhilePending).toBeNull();

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const distant = service.getPreviewMaskOrSchedule({
			source,
			mediaId: "video",
			sourceTime: 2,
			settings: SETTINGS,
		});
		expect(distant).toBeNull();
		expect(calls).toBe(3);
		expect(invalidations).toEqual([1, 1.08]);
	});
});
