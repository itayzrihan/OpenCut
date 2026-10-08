/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Decoder IO is a minimal stand-in; the production cache coordinates all reads. */
import { afterAll, expect, mock, test } from "bun:test";
import type { WrappedCanvas } from "mediabunny";
const seeks: number[] = [];
const originalCanvas = Object.getOwnPropertyDescriptor(
	globalThis,
	"OffscreenCanvas",
);
class FakeCanvas {
	stamp = -1;
	// eslint-disable-next-line opencut/prefer-object-params -- Browser OffscreenCanvas has this positional constructor.
	constructor(
		public width: number,
		public height: number,
	) {}
	getContext() {
		return {
			drawImage: (source: FakeCanvas) => {
				this.stamp = source.stamp;
			},
		};
	}
}
Object.defineProperty(globalThis, "OffscreenCanvas", {
	configurable: true,
	value: FakeCanvas,
});
afterAll(() => {
	if (originalCanvas)
		Object.defineProperty(globalThis, "OffscreenCanvas", originalCanvas);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});
mock.module("@/media/source", () => ({ createMediaSource: () => ({}) }));
mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	Input: class {
		async getPrimaryVideoTrack() {
			return {
				canDecode: async () => true,
				displayWidth: 640,
				displayHeight: 360,
			};
		}
		dispose() {}
	},
	CanvasSink: class {
		private pool: FakeCanvas[];
		private next = 0;
		// eslint-disable-next-line opencut/prefer-object-params -- Matches the external CanvasSink constructor exercised by production IO.
		constructor(_track: unknown, options: { poolSize: number }) {
			this.pool = Array.from(
				{ length: options.poolSize },
				() => new FakeCanvas(640, 360),
			);
		}
		async *canvases(time: number) {
			seeks.push(time);
			const firstTime = Math.floor(time * 30) / 30;
			for (let index = 0; index < 120; index++) {
				const canvas = this.pool[this.next++ % this.pool.length];
				canvas.stamp = firstTime + index / 30;
				yield {
					canvas,
					timestamp: firstTime + index / 30,
					duration: 1 / 30,
				} as unknown as WrappedCanvas;
			}
		}
	},
}));
const { VideoCache } = await import("../service");
test("concurrent distinct readers receive their exact source times instead of a superseded current frame", async () => {
	const cache = new VideoCache();
	const input = { mediaId: "source", url: "blob:source" };
	const original = await cache.getFrameAt({ ...input, time: 0 });
	expect(original?.timestamp).toBe(0);
	const [first, second] = await Promise.all([
		cache.getFrameAt({ ...input, time: 4 }),
		cache.getFrameAt({ ...input, time: 8 }),
	]);
	expect(first?.timestamp).toBe(4);
	expect(second?.timestamp).toBe(8);
	const before = seeks.length;
	const [a, b] = await Promise.all([
		cache.getFrameAt({ ...input, time: 10 }),
		cache.getFrameAt({ ...input, time: 10 }),
	]);
	expect(a).toBe(b);
	expect(a?.timestamp).toBe(10);
	expect(seeks.length - before).toBe(1);
	const [edge, next] = await Promise.all([
		cache.getFrameAt({ ...input, time: 12 - 1 / 120000 }),
		cache.getFrameAt({ ...input, time: 12 }),
	]);
	expect(edge?.timestamp).toBe(359 / 30);
	expect(next?.timestamp).toBe(12);
	// Earlier returned pixels remain at time zero after seek/prefetch pool reuse.
	expect((original?.canvas as unknown as FakeCanvas).stamp).toBe(0);
	expect((first?.canvas as unknown as FakeCanvas).stamp).toBe(4);
	cache.clearAll();
});
