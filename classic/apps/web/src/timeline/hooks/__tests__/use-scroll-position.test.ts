import { describe, expect, test } from "bun:test";
import {
	areScrollPositionsEqual,
	readScrollPosition,
} from "@/timeline/hooks/use-scroll-position";

describe("scroll position helpers", () => {
	test("reads scroll offset and viewport size in one snapshot", () => {
		expect(
			readScrollPosition({
				scrollElement: {
					scrollLeft: 12,
					scrollTop: 34,
					clientWidth: 560,
					clientHeight: 240,
				},
			}),
		).toEqual({
			scrollLeft: 12,
			scrollTop: 34,
			viewportWidth: 560,
			viewportHeight: 240,
		});
	});

	test("compares scroll snapshots by value", () => {
		expect(
			areScrollPositionsEqual({
				a: {
					scrollLeft: 1,
					scrollTop: 2,
					viewportWidth: 3,
					viewportHeight: 4,
				},
				b: {
					scrollLeft: 1,
					scrollTop: 2,
					viewportWidth: 3,
					viewportHeight: 4,
				},
			}),
		).toBe(true);
		expect(
			areScrollPositionsEqual({
				a: {
					scrollLeft: 1,
					scrollTop: 2,
					viewportWidth: 3,
					viewportHeight: 4,
				},
				b: {
					scrollLeft: 1,
					scrollTop: 2,
					viewportWidth: 5,
					viewportHeight: 4,
				},
			}),
		).toBe(false);
	});
});
