import { expect, test } from "bun:test";
import { PlaybackAudioCache } from "../playback-audio-cache";
const buffer = (frames: number) =>
	({ length: frames, numberOfChannels: 2 }) as AudioBuffer;
test("PCM byte budget evicts old data while keeping recently replayed clips", async () => {
	const cache = new PlaybackAudioCache(160, 16);
	const first = Promise.resolve(buffer(10)),
		second = Promise.resolve(buffer(10)),
		third = Promise.resolve(buffer(10));
	cache.set("first", first);
	cache.set("second", second);
	await Promise.resolve();
	expect(cache.get("first")).toBe(first);
	cache.set("third", third);
	await Promise.resolve();
	expect(cache.get("second")).toBeUndefined();
	expect(cache.get("first")).toBe(first);
	expect(cache.get("third")).toBe(third);
	cache.set("large", Promise.resolve(buffer(21)));
	await Promise.resolve();
	expect(cache.get("large")).toBeUndefined();
	expect(cache.size).toBe(2);
});
test("pending work is bounded and old completions cannot republish after project switch or replacement", async () => {
	const cache = new PlaybackAudioCache(160, 2);
	let finish!: (value: AudioBuffer) => void;
	const old = new Promise<AudioBuffer>((resolve) => {
		finish = resolve;
	});
	cache.set("old", old);
	cache.set("two", old);
	cache.set("three", old);
	expect(cache.size).toBe(2);
	expect(cache.get("old")).toBeUndefined();
	cache.clear();
	const current = Promise.resolve(buffer(10));
	cache.set("old", current);
	finish(buffer(100));
	await Promise.resolve();
	expect(cache.get("old")).toBe(current);
	expect(cache.size).toBe(1);
	cache.set("bad", Promise.reject(new Error("decode failed")));
	await Promise.resolve();
	expect(cache.get("bad")).toBeUndefined();
});
