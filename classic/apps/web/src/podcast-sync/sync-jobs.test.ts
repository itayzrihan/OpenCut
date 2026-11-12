import { expect, test } from "bun:test";
import { runSyncWorker } from "./sync-jobs";

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
		const rejected = expect(cancelled).rejects.toThrow("queue check");
		const second = runSyncWorker({ message: { type: "read" } });
		await turn();
		expect(active.map((job) => job.type)).toEqual(["read"]);
		signal.abort(new Error("queue check"));
		await rejected;
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
