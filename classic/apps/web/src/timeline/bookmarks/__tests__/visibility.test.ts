import { describe, expect, test } from "bun:test";
import type { Bookmark } from "@/timeline";
import {
	getBookmarkVisibilityIndex,
	getVisibleBookmarks,
} from "@/timeline/bookmarks/visibility";
import { mediaTime } from "@/wasm";

function bookmark({
	time,
	duration = 0,
}: {
	time: number;
	duration?: number;
}): Bookmark {
	return {
		time: mediaTime({ ticks: time }),
		...(duration > 0 ? { duration: mediaTime({ ticks: duration }) } : {}),
	};
}

function mediaTimes(ticks: number[]) {
	return ticks.map((time) => mediaTime({ ticks: time }));
}

function visibleBookmarks({
	bookmarks,
	visibleStartTime,
	visibleEndTime,
	draggedBookmarkTime = null,
}: {
	bookmarks: Bookmark[];
	visibleStartTime: number;
	visibleEndTime: number;
	draggedBookmarkTime?: number | null;
}) {
	return getVisibleBookmarks({
		bookmarks,
		visibilityIndex: getBookmarkVisibilityIndex({ bookmarks }),
		visibleStartTime,
		visibleEndTime,
		draggedBookmarkTime,
	});
}

describe("bookmark visibility", () => {
	test("returns only bookmarks overlapping the visible time window", () => {
		const bookmarks = Array.from({ length: 1000 }, (_, index) =>
			bookmark({ time: index * 10 }),
		);

		expect(
			visibleBookmarks({
				bookmarks,
				visibleStartTime: 5_000,
				visibleEndTime: 5_050,
			}).map((item) => item.time),
		).toEqual(mediaTimes([5_000, 5_010, 5_020, 5_030, 5_040, 5_050]));
	});

	test("keeps duration bookmarks visible when they start before the viewport", () => {
		const bookmarks = [
			bookmark({ time: 100, duration: 500 }),
			bookmark({ time: 700 }),
		];

		expect(
			visibleBookmarks({
				bookmarks,
				visibleStartTime: 550,
				visibleEndTime: 560,
			}).map((item) => item.time),
		).toEqual(mediaTimes([100]));
	});

	test("keeps a dragged bookmark mounted outside the visible window", () => {
		const bookmarks = Array.from({ length: 10 }, (_, index) =>
			bookmark({ time: index * 100 }),
		);

		expect(
			visibleBookmarks({
				bookmarks,
				visibleStartTime: 400,
				visibleEndTime: 500,
				draggedBookmarkTime: 900,
			}).map((item) => item.time),
		).toEqual(mediaTimes([400, 500, 900]));
	});

	test("preserves filtering behavior when imported bookmarks are not sorted", () => {
		const bookmarks = [
			bookmark({ time: 500 }),
			bookmark({ time: 100 }),
			bookmark({ time: 300, duration: 300 }),
		];

		expect(
			visibleBookmarks({
				bookmarks,
				visibleStartTime: 550,
				visibleEndTime: 560,
			}).map((item) => item.time),
		).toEqual(mediaTimes([300]));
	});
});
