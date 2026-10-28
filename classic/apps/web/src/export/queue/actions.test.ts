import { test, expect, mock, afterAll } from "bun:test";
import type { RenderQueueView } from "./types";
const calls: unknown[] = [];
let next: unknown[] = [];
mock.module("./client", () => ({
	renderQueueRequest: async (body?: unknown) => {
		calls.push(body);
		const v = next.shift();
		if (v instanceof Error) throw v;
		return v;
	},
}));
const { changeQueuedRender } = await import("./actions");
afterAll(() => mock.restore());
const state = {
	revision: 3,
	jobs: [
		{
			id: "job",
			projectId: "project",
			snapshotHash: "frozen",
			status: "failed",
		},
	],
} as RenderQueueView;
test("retry rebases a progress-only revision conflict without replacing snapshot/settings", async () => {
	calls.length = 0;
	const fresh = { ...state, revision: 5 };
	next = [
		new Error("Queue changed; refresh and try again"),
		fresh,
		{ ...fresh, revision: 6 },
	];
	const result = await changeQueuedRender({
		id: "job",
		projectId: "project",
		action: "retry",
		state,
	});
	expect(result.revision).toBe(6);
	expect(calls).toEqual([
		{ action: "retry", id: "job", projectId: "project", expectedRevision: 3 },
		undefined,
		{ action: "retry", id: "job", projectId: "project", expectedRevision: 5 },
	]);
});
test("a concurrently retried job is not retried again", async () => {
	calls.length = 0;
	const fresh = {
		revision: 5,
		jobs: [{ ...state.jobs[0], status: "rendering" }],
	} as RenderQueueView;
	next = [new Error("Queue changed"), fresh];
	expect(
		await changeQueuedRender({
			id: "job",
			projectId: "project",
			action: "retry",
			state,
		}),
	).toBe(fresh);
	expect(calls.length).toBe(2);
});
