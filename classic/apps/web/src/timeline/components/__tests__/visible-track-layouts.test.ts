import { describe, expect, test } from "bun:test";
import { getVisibleTrackLayouts } from "@/timeline/components/visible-track-layouts";

function layout({
	index,
	top,
	height = 50,
}: {
	index: number;
	top: number;
	height?: number;
}) {
	return { index, top, height, id: `track-${index}` };
}

describe("visible track layouts", () => {
	test("returns only layouts overlapping the visible vertical window", () => {
		const layouts = Array.from({ length: 1000 }, (_, index) =>
			layout({ index, top: index * 60 }),
		);

		expect(
			getVisibleTrackLayouts({
				layouts,
				scrollTop: 30_000,
				viewportHeight: 180,
				overscanPx: 0,
			}).map((item) => item.index),
		).toEqual([500, 501, 502, 503]);
	});

	test("keeps tall layouts visible when they start before the viewport", () => {
		const layouts = [
			layout({ index: 0, top: 0, height: 500 }),
			layout({ index: 1, top: 510 }),
		];

		expect(
			getVisibleTrackLayouts({
				layouts,
				scrollTop: 400,
				viewportHeight: 50,
				overscanPx: 0,
			}).map((item) => item.index),
		).toEqual([0]);
	});

	test("keeps forced tracks mounted outside the visible window", () => {
		const layouts = Array.from({ length: 10 }, (_, index) =>
			layout({ index, top: index * 60 }),
		);

		expect(
			getVisibleTrackLayouts({
				layouts,
				scrollTop: 240,
				viewportHeight: 60,
				overscanPx: 0,
				forcedIndexes: new Set([9]),
			}).map((item) => item.index),
		).toEqual([4, 5, 9]);
	});
});
