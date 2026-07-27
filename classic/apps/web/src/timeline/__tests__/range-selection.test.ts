import { describe, expect, test } from "bun:test";
import {
	getSelectedTimelineRange,
	normalizeTimelineRange,
	type TimelineRangeSelection,
} from "@/timeline/range-selection";
import type { MediaTime } from "@/wasm";

const t = (time: number) => {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test fixtures use integer ticks.
	return time as MediaTime;
};

describe("timeline range selection", () => {
	test("normalizes reversed drag direction", () => {
		const range = normalizeTimelineRange({
			startTime: t(900),
			endTime: t(100),
		});

		expect(range.startTime).toBe(100);
		expect(range.endTime).toBe(900);
		expect(range.duration).toBe(800);
	});

	test("ignores zero-width selections", () => {
		const state: TimelineRangeSelection = {
			mode: "selected",
			startTime: t(250),
			endTime: t(250),
			anchorTime: t(250),
			isTimelineLocked: true,
			isPromptOpen: true,
		};

		expect(getSelectedTimelineRange(state)).toBeNull();
	});
});
