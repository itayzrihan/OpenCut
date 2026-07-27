import { describe, expect, test } from "bun:test";
import { getTimelineRulerVisibleTickRange } from "@/timeline/components/timeline-ruler-visibility";

function rangeSize({
	startTickIndex,
	endTickIndex,
}: {
	startTickIndex: number;
	endTickIndex: number;
}) {
	return endTickIndex - startTickIndex + 1;
}

describe("timeline ruler visibility", () => {
	test("keeps the rendered tick count bounded while scrolling far right", () => {
		const baseParams = {
			viewportWidth: 1_000,
			pixelsPerSecond: 100,
			tickIntervalSeconds: 1,
			tickCount: 100_000,
		};

		const nearRange = getTimelineRulerVisibleTickRange({
			...baseParams,
			scrollLeft: 10_000,
		});
		const farRange = getTimelineRulerVisibleTickRange({
			...baseParams,
			scrollLeft: 100_000,
		});

		expect(rangeSize(farRange)).toBe(rangeSize(nearRange));
		expect(farRange.startTickIndex).toBeGreaterThan(nearRange.startTickIndex);
	});

	test("clamps the visible range to the available tick indexes", () => {
		expect(
			getTimelineRulerVisibleTickRange({
				scrollLeft: 0,
				viewportWidth: 1_000,
				pixelsPerSecond: 100,
				tickIntervalSeconds: 1,
				tickCount: 8,
			}),
		).toEqual({ startTickIndex: 0, endTickIndex: 7 });
	});
});
