import { expect, mock, test } from "bun:test";
let duration = 45.6;
let opened = 0;
let closed = 0;
let missingTrack = false;
mock.module("@/media/source", () => ({
	createMediaSource: ({ url }: { url: string }) => ({ url }),
}));
mock.module("mediabunny", () => ({
	ALL_FORMATS: [],
	Input: class {
		constructor() {
			opened++;
		}
		async getPrimaryAudioTrack() {
			return missingTrack ? null : { computeDuration: async () => duration };
		}
		dispose() {
			closed++;
		}
	},
}));
const { measureMusicDuration } = await import("../music-duration");
test("background music measures encoded duration without a document/audio element", async () => {
	opened = 0;
	closed = 0;
	duration = 45.6;
	missingTrack = false;
	expect(
		await measureMusicDuration({
			url: "/music.mp3",
			signal: new AbortController().signal,
		}),
	).toBe(45.6);
	expect(opened).toBe(1);
	expect(closed).toBe(1);
});
test("invalid and absent audio durations reject and always release the reader", async () => {
	for (const value of [0, Infinity, NaN]) {
		duration = value;
		missingTrack = false;
		closed = 0;
		await expect(
			measureMusicDuration({
				url: "/music.mp3",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("duration");
		expect(closed).toBe(1);
	}
	missingTrack = true;
	closed = 0;
	await expect(
		measureMusicDuration({
			url: "/empty.mp3",
			signal: new AbortController().signal,
		}),
	).rejects.toThrow("no audio track");
	expect(closed).toBe(1);
	missingTrack = false;
});
test("cancelled music probing does not open a new reader", async () => {
	const controller = new AbortController();
	controller.abort();
	opened = 0;
	await expect(
		measureMusicDuration({ url: "/music.mp3", signal: controller.signal }),
	).rejects.toThrow();
	expect(opened).toBe(0);
});
