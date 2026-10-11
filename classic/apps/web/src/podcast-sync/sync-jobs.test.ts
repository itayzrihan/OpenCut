import { expect, test } from "bun:test";
import { mapConcurrent } from "./sync-jobs";

test("all sources share a bounded concurrent job, preserving source order", async () => {
	let active = 0,
		peak = 0;
	const output = await mapConcurrent({
		items: Array.from({ length: 19 }, (_, i) => i),
		concurrency: 4,
		task: async (i) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, i % 3));
			active--;
			return i * 3;
		},
	});
	expect(peak).toBe(4);
	expect(output).toEqual(Array.from({ length: 19 }, (_, i) => i * 3));
});
test("cancelling a group stops running work and does not start queued sources", async () => {
	const controller = new AbortController();
	let started = 0,
		cancelled = 0;
	const work = mapConcurrent({
		items: Array(20).fill(0),
		concurrency: 3,
		task: async (_, signal) => {
			started++;
			return new Promise((_, reject) =>
				signal.addEventListener(
					"abort",
					() => {
						cancelled++;
						reject(signal.reason);
					},
					{ once: true },
				),
			);
		},
		signal: controller.signal,
	});
	controller.abort(new Error("cancelled"));
	await expect(work).rejects.toThrow("cancelled");
	expect(started).toBe(3);
	expect(cancelled).toBe(3);
});
test("failure cancels sibling decodes instead of leaving background IO", async () => {
	let cancelled = false;
	await expect(
		mapConcurrent({
			items: [0, 1, 2, 3],
			concurrency: 2,
			task: async (i, signal) => {
				if (i === 0) {
					await Promise.resolve();
					throw new Error("no audio");
				}
				return new Promise((_, reject) =>
					signal.addEventListener(
						"abort",
						() => {
							cancelled = true;
							reject(signal.reason);
						},
						{ once: true },
					),
				);
			},
		}),
	).rejects.toThrow("no audio");
	expect(cancelled).toBe(true);
});
