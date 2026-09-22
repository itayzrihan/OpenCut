import { expect, test } from "bun:test";
import { runProcess } from "./run-process";

test("drains subprocess output without blocking completion", async () => {
	await runProcess({
		command: process.execPath,
		args: ["-e", "process.stdout.write('x'.repeat(2_000_000));"],
		timeoutMs: 5000,
	});
});
test("cancellation terminates and rejects a running child", async () => {
	const controller = new AbortController();
	const pending = runProcess({
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
});
test("timeout rejects instead of leaving an orphan child", async () => {
	await expect(
		runProcess({
			command: process.execPath,
			args: ["-e", "setInterval(()=>{},1000)"],
			timeoutMs: 100,
		}),
	).rejects.toThrow("timed out");
});
