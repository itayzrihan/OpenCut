import { describe, expect, test } from "bun:test";
import { findAdjacentKeyframeTimes } from "../hooks/keyframe-navigation";

describe("property keyframe navigation", () => {
	test("finds the adjacent unique keyframes around the playhead", () => {
		const adjacent = findAdjacentKeyframeTimes({
			keyframeTimes: [300, 100, 300],
			currentTime: 200,
		});

		expect(adjacent.previous).toBe(100);
		expect(adjacent.next).toBe(300);
	});

	test("disables navigation beyond the first and last keyframes", () => {
		const first = findAdjacentKeyframeTimes({
			keyframeTimes: [100, 300],
			currentTime: 100,
		});
		const last = findAdjacentKeyframeTimes({
			keyframeTimes: [100, 300],
			currentTime: 300,
		});

		expect(first.previous).toBeNull();
		expect(first.next).toBe(300);
		expect(last.previous).toBe(100);
		expect(last.next).toBeNull();
	});
});
