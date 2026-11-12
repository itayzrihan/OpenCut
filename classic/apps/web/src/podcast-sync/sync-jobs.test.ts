import { expect, test } from "bun:test";
import { mapConcurrent, runSyncWorker } from "./sync-jobs";

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

test("a large alignment gets the worker budget and queued cancellation opens the queue", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "Worker");
	const active: Array<{ type: string; finish: () => void }> = [];
	class TestWorker {
		onmessage?: (event: { data: { result: boolean } }) => void;
		postMessage({ type }: { type: string }) {
			active.push({
				type,
				finish: () => this.onmessage?.({ data: { result: true } }),
			});
		}
		terminate() {}
	}
	Object.defineProperty(globalThis, "Worker", {
		configurable: true,
		value: TestWorker,
	});
	const signal = new AbortController();
	const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	try {
		const light = runSyncWorker({ message: { type: "read" } });
		const cancelled = runSyncWorker({
			message: { type: "align" },
			signal: signal.signal,
		});
		const rejected = cancelled.catch((error: unknown) => error);
		const second = runSyncWorker({ message: { type: "read" } });
		await turn();
		expect(active.map((job) => job.type)).toEqual(["read"]);
		signal.abort(new Error("queue check"));
		expect(await rejected).toEqual(new Error("queue check"));
		await turn();
		expect(active.map((job) => job.type)).toEqual(["read", "read"]);
		active[0]!.finish();
		active[1]!.finish();
		await Promise.all([light, second]);

		const large = runSyncWorker({ message: { type: "align" } });
		const next = runSyncWorker({ message: { type: "read" } });
		await turn();
		expect(active.map((job) => job.type)).toEqual(["read", "read", "align"]);
		active[2]!.finish();
		await large;
		await turn();
		expect(active.at(-1)?.type).toBe("read");
		active[3]!.finish();
		await next;
	} finally {
		if (original) Object.defineProperty(globalThis, "Worker", original);
		else Reflect.deleteProperty(globalThis, "Worker");
	}
});
