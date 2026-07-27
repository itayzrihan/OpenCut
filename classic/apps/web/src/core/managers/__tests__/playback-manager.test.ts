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
});
