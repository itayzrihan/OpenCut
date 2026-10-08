import { expect, test } from "bun:test";
import { createWorkerReadiness } from "./worker-readiness";

test("startup waits for an actual iframe handshake and later jobs reuse readiness", async () => {
	const ready = createWorkerReadiness();
	let queued = 0;
	const first = ready.wait().then(() => queued++);
	const second = ready.wait().then(() => queued++);
	await Promise.resolve();
	expect(queued).toBe(0);
	ready.markReady();
	await Promise.all([first, second]);
	expect(queued).toBe(2);
	await ready.wait();
});
test("a missing worker fails before queueing and can recover on the next attempt", async () => {
	const ready = createWorkerReadiness();
	await expect(ready.wait({ timeoutMs: 5 })).rejects.toThrow(
		"Nothing was queued",
	);
	ready.markReady();
	await ready.wait();
});
