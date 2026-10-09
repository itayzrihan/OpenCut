import { expect, mock, test } from "bun:test";
let opens = 0;
let closes = 0;
let reads = 0;
let resolveTrack: ((track: object | null) => void) | undefined;
let delayed = false;
mock.module("@/media/source", () => ({ createMediaSource: () => ({}) }));
mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	Input: class {
		constructor() {
			opens++;
		}
		getPrimaryAudioTrack() {
			reads++;
			return delayed
				? new Promise<object | null>((resolve) => {
						resolveTrack = resolve;
					})
				: Promise.resolve({});
		}
		dispose() {
			closes++;
		}
	},
	AudioBufferSink: class {},
}));
const { AudioSinkCache } = await import("../audio-sink-cache");
test("39 Smart Takes and concurrent warmup reuse one media parser", async () => {
	const cache = new AudioSinkCache();
	const before = { opens, reads, closes };
	const sinks = await Promise.all(
		Array.from({ length: 39 }, () =>
			cache.get({ sourceKey: "interview", url: "/source.mp4" }),
		),
	);
	expect(new Set(sinks).size).toBe(1);
	expect(sinks[0]).not.toBeNull();
	expect(opens - before.opens).toBe(1);
	expect(reads - before.reads).toBe(1);
	cache.clear();
	expect(closes - before.closes).toBe(1);
});
test("a project switch disposes pending input and never publishes its old sink", async () => {
	const cache = new AudioSinkCache();
	delayed = true;
	const pending = cache.get({ sourceKey: "same-id", url: "/old" });
	const finishOld = resolveTrack!;
	cache.clear();
	delayed = false;
	const current = await cache.get({ sourceKey: "same-id", url: "/new" });
	finishOld({});
	expect(await pending).toBeNull();
	expect(await cache.get({ sourceKey: "same-id", url: "/new" })).toBe(current);
	cache.clear();
});
test("missing audio releases the input and allows a later retry", async () => {
	const cache = new AudioSinkCache();
	delayed = true;
	const pending = cache.get({ sourceKey: "missing", url: "/source" });
	resolveTrack!(null);
	expect(await pending).toBeNull();
	delayed = false;
	expect(
		await cache.get({ sourceKey: "missing", url: "/source" }),
	).not.toBeNull();
	cache.clear();
});
