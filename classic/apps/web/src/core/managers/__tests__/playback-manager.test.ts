import { afterEach, describe, expect, test } from "bun:test";
import {
	PlaybackManager,
	type PlaybackManagerEditor,
} from "@/core/managers/playback-manager";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";

const FPS_30 = { numerator: 30, denominator: 1 };

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalPerformanceNow = performance.now.bind(performance);

let now = 0;
let pendingFrame: FrameRequestCallback | null = null;

function installMockClock() {
	now = 0;
	pendingFrame = null;
	Object.defineProperty(performance, "now", {
		configurable: true,
		value: () => now,
	});
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		pendingFrame = callback;
		return 1;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((id: number) => {
		void id;
		pendingFrame = null;
	}) as typeof cancelAnimationFrame;
}

function restoreMockClock() {
	Object.defineProperty(performance, "now", {
		configurable: true,
		value: originalPerformanceNow,
	});
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	pendingFrame = null;
}

function runPendingFrame({ atMs }: { atMs: number }) {
	const callback = pendingFrame;
	if (!callback) {
		throw new Error("Expected a pending animation frame");
	}
	pendingFrame = null;
	now = atMs;
	callback(atMs);
}

function createPlaybackManager() {
	const editor: PlaybackManagerEditor = {
		project: {
			getActive: () => ({ settings: { fps: FPS_30 } }),
		},
		timeline: {
			getTotalDuration: () => mediaTimeFromSeconds({ seconds: 10 }),
			subscribe: () => () => {},
		},
		scenes: {
			subscribe: () => () => {},
		},
	};
	return new PlaybackManager(editor);
}

afterEach(() => {
	restoreMockClock();
});

describe("playback manager", () => {
	test("does not advance the timeline until registered prebuffer work completes", async () => {
		installMockClock();
		const playback = createPlaybackManager();
		let releaseBuffer: () => void = () => {};
		playback.registerPlaybackPreparer({
			id: "test-buffer",
			prepare: () =>
				new Promise<void>((resolve) => {
					releaseBuffer = resolve;
				}),
		});

		playback.play();
		expect(playback.getIsBuffering()).toBe(true);
		expect(playback.getIsPlaying()).toBe(false);
		expect(pendingFrame).toBeNull();

		releaseBuffer();
		await Promise.resolve();
		await Promise.resolve();

		expect(playback.getIsBuffering()).toBe(false);
		expect(playback.getIsPlaying()).toBe(true);
		expect(pendingFrame).not.toBeNull();
	});

	test("does not notify update listeners until rounded frame time advances", () => {
		installMockClock();
		const playback = createPlaybackManager();
		const updates: number[] = [];
		playback.onUpdate((time) => updates.push(time));

		playback.play();
		expect(updates).toEqual([]);

		runPendingFrame({ atMs: 10 });
		expect(updates).toEqual([]);

		runPendingFrame({ atMs: 20 });
		expect(updates).toEqual([mediaTime({ ticks: 4_000 })]);

		runPendingFrame({ atMs: 25 });
		expect(updates).toEqual([mediaTime({ ticks: 4_000 })]);
	});

	test("exposes the live playback clock before the next animation frame", () => {
		installMockClock();
		const playback = createPlaybackManager();

		playback.play();
		now = 750;

		expect(playback.getCurrentTime()).toBe(mediaTime({ ticks: 0 }));
		expect(playback.getClockTime()).toBe(
			mediaTimeFromSeconds({ seconds: 0.75 }),
		);
	});

	test("suspension cancels RAF, blocks play, and restores prior playback", () => {
		installMockClock();
		const playback = createPlaybackManager();
		playback.play();
		expect(playback.getIsPlaying()).toBe(true);
		expect(pendingFrame).not.toBeNull();

		const release = playback.suspend();
		expect(playback.getIsPlaying()).toBe(false);
		expect(pendingFrame).toBeNull();

		playback.play();
		expect(playback.getIsPlaying()).toBe(false);
		expect(pendingFrame).toBeNull();

		release();
		expect(playback.getIsPlaying()).toBe(true);
		expect(pendingFrame).not.toBeNull();
	});

	test("suspension leaves previously paused playback paused", () => {
		installMockClock();
		const playback = createPlaybackManager();

		const release = playback.suspend();
		release();

		expect(playback.getIsPlaying()).toBe(false);
		expect(pendingFrame).toBeNull();
	});
});
