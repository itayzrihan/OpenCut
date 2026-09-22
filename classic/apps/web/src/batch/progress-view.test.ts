import { expect, mock, test } from "bun:test";
import type { BatchRun } from "./types";
mock.module("opencut-wasm", () => ({
	batchEditIsLocked: ({ status }: { status: string }) =>
		["queued", "ready", "importing", "running"].includes(status),
	fullAutoEditStages: () => [
		"preflight",
		"framing",
		"silence",
		"auto-texts",
		"finish",
		"save",
	],
}));
const { automationView } = await import("./progress-view");
function run({
	id,
	status,
}: {
	id: string;
	status: "running" | "completed" | "ready" | "failed";
}): BatchRun {
	return {
		id,
		options: {
			zoom: false,
			transitions: false,
			wordAnimation: false,
			music: false,
		},
		updatedAt: 100,
		jobs: [
			{
				projectId: id,
				name: id,
				fileName: id,
				status,
				created: true,
				cancelRequested: false,
				completedStages: status === "completed" ? 6 : 2,
				message: id,
			},
		],
	};
}
test("all background jobs remain represented, with the executing run selected across routes", () => {
	const state = {
		executionRunId: "first",
		runs: [
			run({ id: "second", status: "ready" }),
			run({ id: "first", status: "running" }),
		],
	};
	const view = automationView({ state, openedAt: 200, selection: "" });
	expect(view.totalVideos).toBe(2);
	expect(view.job?.projectId).toBe("first");
	expect(view.active).toBe(true);
	expect(
		automationView({ state, openedAt: 200, selection: "second:second" })
			.activityMessage,
	).toBe("first");
	expect(
		automationView({ state, openedAt: 200, selection: "second:second" }).job
			?.projectId,
	).toBe("second");
});
test("recent completed runs stay in totals and failed jobs do not count as successes", () => {
	const view = automationView({
		state: {
			runs: [
				run({ id: "failed", status: "failed" }),
				run({ id: "done", status: "completed" }),
				run({ id: "current", status: "running" }),
			],
		},
		openedAt: 50,
		selection: "",
	});
	expect(view.ready).toBe(1);
	expect(view.stopped).toBe(2);
	expect(view.totalVideos).toBe(3);
	expect(view.active).toBe(true);
});
test("newest completion remains visible after the last worker exits", () => {
	const view = automationView({
		state: { runs: [run({ id: "done", status: "completed" })] },
		openedAt: 200,
		selection: "",
	});
	expect(view.percent).toBe(100);
	expect(view.ready).toBe(1);
	expect(view.active).toBe(false);
});
