import { describe, expect, test } from "bun:test";
import { getToolbarFrameTime } from "@/timeline/components/toolbar-frame-time";
import { mediaTime } from "@/wasm";

const FPS_30 = { numerator: 30, denominator: 1 };

describe("toolbar frame time", () => {
	test("collapses playback ticks inside the same frame", () => {
		expect(
			getToolbarFrameTime({
				time: mediaTime({ ticks: 1 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 0 }));
		expect(
			getToolbarFrameTime({
				time: mediaTime({ ticks: 1_999 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 0 }));
	});

	test("rounds to the next frame after the midpoint", () => {
		expect(
			getToolbarFrameTime({
				time: mediaTime({ ticks: 2_000 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 4_000 }));
		expect(
			getToolbarFrameTime({
				time: mediaTime({ ticks: 4_001 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 4_000 }));
	});
});
