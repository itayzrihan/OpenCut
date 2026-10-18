import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { isBridgeProcessAlive, settleBridgeRequests } from "./bridge-transport";

test("body-free command long polls can all start without waiting for earlier polls", async () => {
	const releases: Array<() => void> = [];
	const pending = settleBridgeRequests({
		configs: Array.from({ length: 8 }, (_, i) => i),
		concurrency: 8,
		run: () => new Promise<void>((resolve) => releases.push(resolve)),
	});
	expect(releases).toHaveLength(8);
	for (const release of releases) release();
	expect(await pending).toHaveLength(8);
});

test("exited bridge processes are excluded while the current process remains", async () => {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	const pid = child.pid!;
	await new Promise<void>((resolve, reject) => {
		child.once("exit", () => resolve());
		child.once("error", reject);
	});
	expect(isBridgeProcessAlive({ pid })).toBe(false);
	expect(isBridgeProcessAlive({ pid: process.pid })).toBe(true);
	expect(isBridgeProcessAlive({ pid: -1 })).toBe(false);
});

test("hundreds of registrations have bounded fanout and preserve all outcomes", async () => {
	let active = 0,
		peak = 0;
	const results = await settleBridgeRequests({
		configs: Array.from({ length: 832 }, (_, index) => index),
		run: async (index) => {
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setTimeout(resolve, 0));
			active--;
			if (index === 17) throw new Error("closed bridge");
			return index;
		},
	});
	expect(peak).toBe(4);
	expect(results).toHaveLength(832);
	expect(results[17].status).toBe("rejected");
	expect(results[831]).toEqual({ status: "fulfilled", value: 831 });
});
