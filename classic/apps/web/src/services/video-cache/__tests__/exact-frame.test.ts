/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Decoder IO is a minimal stand-in; the production cache coordinates all reads. */
import { expect, mock, test } from "bun:test";
import type { WrappedCanvas } from "mediabunny";
const seeks: number[] = [];
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
		async *canvases(time: number) {
			seeks.push(time);
			const firstTime = Math.floor(time * 30) / 30;
			for (let index = 0; index < 120; index++)
				yield {
					canvas: {},
					timestamp: firstTime + index / 30,
					duration: 1 / 30,
				} as WrappedCanvas;
		}
	},
}));
const { VideoCache } = await import("../service");
test("concurrent distinct readers receive their exact source times instead of a superseded current frame", async () => {
	const cache = new VideoCache();
	const input = { mediaId: "source", url: "blob:source" };
	expect((await cache.getFrameAt({ ...input, time: 0 }))?.timestamp).toBe(0);
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
	cache.clearAll();
});
