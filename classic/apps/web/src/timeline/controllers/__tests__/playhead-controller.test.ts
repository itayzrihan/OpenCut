import { describe, expect, test } from "bun:test";
import { getPlayheadLeftPx } from "@/timeline/playhead-position";
import { mediaTimeFromSeconds } from "@/wasm/media-time";

describe("playhead controller", () => {
	test("computes playhead left from snapped timeline position and scroll offset", () => {
		expect(
			getPlayheadLeftPx({
				time: mediaTimeFromSeconds({ seconds: 2 }),
				zoomLevel: 1,
				scrollLeft: 25,
			}),
		).toBe(74);
	});
});
