import { expect, test } from "bun:test";
import { createBatchUpdateQueue } from "./update-queue";

test("slow storage coalesces progress and heartbeat but preserves lifecycle order", async () => {
	const seen: Record<string, unknown>[] = [];
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const send = createBatchUpdateQueue(async (data) => {
		seen.push(data);
		if (seen.length === 1) await blocked;
	});
	const start = send({ event: "run" });
	await Promise.resolve();
	for (let i = 0; i < 100; i++)
		void send(
			{ projectId: "a", completedStages: i, message: `stage ${i}` },
			true,
		);
	void send({}, true);
	const complete = send({ projectId: "a", event: "complete" });
	const next = send({ projectId: "b", message: "next" }, true);
	release();
	await Promise.all([start, complete, next]);
	expect(seen).toEqual([
		{ event: "run" },
		{ projectId: "a", completedStages: 99, message: "stage 99" },
		{ projectId: "a", event: "complete" },
		{ projectId: "b", message: "next" },
	]);
});

test("failed IO is reported and does not poison a later retry", async () => {
	let attempt = 0;
	const send = createBatchUpdateQueue(async () => {
		if (attempt++ === 0) throw new Error("offline");
		return "saved";
	});
	await expect(send()).rejects.toThrow("offline");
	expect(await send()).toBe("saved");
});
