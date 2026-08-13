/* eslint-disable @typescript-eslint/no-unsafe-type-assertion, opencut/prefer-object-params -- Browser API test doubles intentionally mirror Worker signatures. */
import { describe, expect, test } from "bun:test";
import type { ResolvedBackgroundRemovalSettings } from "@/background-removal";
import {
	BackgroundRemovalService,
	type BackgroundRemovalServiceOptions,
} from "@/services/background-removal/service";
import type { BackgroundRemovalWorkerMessage } from "../protocol";

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

class FakeWorker {
	messages: BackgroundRemovalWorkerMessage[] = [];
	terminateCalls = 0;
	private messageListeners = new Set<EventListener>();
	private errorListeners = new Set<EventListener>();

	postMessage(message: BackgroundRemovalWorkerMessage): void {
		this.messages.push(message);
	}

	addEventListener(type: string, listener: EventListener): void {
		if (type === "message") this.messageListeners.add(listener);
		if (type === "error") this.errorListeners.add(listener);
	}

	removeEventListener(type: string, listener: EventListener): void {
		if (type === "message") this.messageListeners.delete(listener);
		if (type === "error") this.errorListeners.delete(listener);
	}

	terminate(): void {
		this.terminateCalls++;
	}
}

function createBitmap() {
	let closeCalls = 0;
	return {
		bitmap: {
			width: 512,
			height: 910,
			close: () => {
				closeCalls++;
			},
		} as ImageBitmap,
		getCloseCalls: () => closeCalls,
	};
}

function createServiceOptions(
	overrides: Partial<BackgroundRemovalServiceOptions> = {},
): BackgroundRemovalServiceOptions {
	return {
		autoHydrate: false,
		persistence: null,
		...overrides,
	};
}

describe("BackgroundRemovalService worker lifecycle", () => {
	test("snapshots a mutable source before awaiting model preload and aborts promptly", async () => {
		const order: string[] = [];
		const { bitmap, getCloseCalls } = createBitmap();
		const service = new BackgroundRemovalService(
			createServiceOptions({
				inferenceBitmapFactory: async () => {
					order.push("snapshot");
					return bitmap;
				},
			}),
		);
		service.preload = () => {
			order.push("preload");
			return new Promise<void>(() => undefined);
		};
		const controller = new AbortController();
		const segmentation = service.segmentFrame({
			source: {} as CanvasImageSource,
			mediaId: "video",
			sourceTime: 1,
			settings: SETTINGS,
			isPreview: false,
			signal: controller.signal,
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(order).toEqual(["snapshot", "preload"]);
		controller.abort();
		await expect(segmentation).rejects.toMatchObject({ name: "AbortError" });
		expect(getCloseCalls()).toBe(1);
	});

	test("times out a request, cancels its generation, and terminates the stuck worker", async () => {
		const workers: FakeWorker[] = [];
		const service = new BackgroundRemovalService(
			createServiceOptions({
				requestTimeoutMs: 5,
				workerFactory: () => {
					const worker = new FakeWorker();
					workers.push(worker);
					return worker as unknown as Worker;
				},
				inferenceBitmapFactory: async () => createBitmap().bitmap,
			}),
		);
		service.preload = async () => undefined;

		const segmentation = service.segmentFrame({
			source: {} as CanvasImageSource,
			mediaId: "video",
			sourceTime: 1,
			settings: SETTINGS,
			isPreview: false,
			temporalSequenceKey: "group:cut",
		});
		await expect(segmentation).rejects.toThrow("Background removal timed out");

		expect(workers).toHaveLength(1);
		expect(workers[0]?.messages.map((message) => message.type)).toEqual([
			"segment",
			"cancel",
		]);
		expect(workers[0]?.terminateCalls).toBe(1);
		const segmentMessage = workers[0]?.messages.find(
			(message) => message.type === "segment",
		);
		expect(
			segmentMessage?.type === "segment" ? segmentMessage.sequenceKey : null,
		).toBe("group:cut:video:512:0.500:1.000:0.240");
	});
});
