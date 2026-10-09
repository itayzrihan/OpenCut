import { describe, expect, test } from "bun:test";
import { pushBrollProgress } from "@/services/renderer/nodes/push-broll-node";
describe("synchronized B-roll", () => {
	test("seek-safe entry, hold and exit", () => {
		expect(
			pushBrollProgress({ time: 9, start: 10, duration: 5, transition: 0.4 }),
		).toBe(0);
		expect(
			pushBrollProgress({ time: 10, start: 10, duration: 5, transition: 0.4 }),
		).toBe(0);
		expect(
			pushBrollProgress({
				time: 10.2,
				start: 10,
				duration: 5,
				transition: 0.4,
			}),
		).toBeCloseTo(0.5);
		expect(
			pushBrollProgress({ time: 12, start: 10, duration: 5, transition: 0.4 }),
		).toBe(1);
		expect(
			pushBrollProgress({
				time: 14.8,
				start: 10,
				duration: 5,
				transition: 0.4,
			}),
		).toBeCloseTo(0.5);
		expect(
			pushBrollProgress({ time: 15, start: 10, duration: 5, transition: 0.4 }),
		).toBe(0);
	});
	test("short clips meet at a full reveal", () => {
		expect(
			pushBrollProgress({
				time: 0.1,
				start: 0,
				duration: 0.2,
				transition: 0.4,
			}),
		).toBe(1);
		expect(
			pushBrollProgress({
				time: 0.05,
				start: 0,
				duration: 0.2,
				transition: 0.4,
			}),
		).toBeCloseTo(0.5);
		expect(
			pushBrollProgress({ time: 0, start: 0, duration: 1, transition: 0 }),
		).toBe(1);
	});
});
