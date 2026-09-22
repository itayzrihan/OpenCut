import { batchEditIsLocked, fullAutoEditStages } from "opencut-wasm";
import type { BatchState } from "./types";

/** Presentation only: the queue and documents remain owned by the host and EditorCore. */
export function automationView({
	state,
	openedAt,
	selection,
}: {
	state: BatchState;
	openedAt: number;
	selection: string;
}) {
	const activeRuns = state.runs.filter((r) =>
		r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
	);
	const recentRuns = state.runs.filter((r) => r.updatedAt >= openedAt);
	const runs = state.runs.filter(
		(r) => activeRuns.includes(r) || recentRuns.includes(r),
	);
	if (
		!runs.length &&
		state.runs[0] &&
		openedAt - state.runs[0].updatedAt < 600000
	)
		runs.push(state.runs[0]);
	const entries = runs.flatMap((run) => run.jobs.map((job) => ({ run, job })));
	const executing =
		entries.find(
			(e) =>
				e.run.id === state.executionRunId &&
				["running", "importing"].includes(e.job.status),
		) ??
		entries.find(
			(e) =>
				e.run.id === state.executionRunId &&
				batchEditIsLocked({ status: e.job.status }),
		) ??
		entries.find((e) => batchEditIsLocked({ status: e.job.status })) ??
		entries[0];
	const selected =
		entries.find((e) => `${e.run.id}:${e.job.projectId}` === selection) ??
		executing;
	const stages = selected ? fullAutoEditStages(selected.run.options) : [];
	const totalStages = entries.reduce(
		(n, e) => n + fullAutoEditStages(e.run.options).length,
		0,
	);
	const stageWork = entries.reduce((n, e) => n + e.job.completedStages, 0);
	const ready = entries.filter((e) => e.job.status === "completed").length;
	const stopped = entries.filter(
		(e) => !batchEditIsLocked({ status: e.job.status }),
	).length;
	return {
		entries,
		run: selected?.run,
		job: selected?.job,
		stages,
		completed: selected?.job.completedStages ?? 0,
		totalVideos: entries.length,
		ready,
		stopped,
		active: activeRuns.length > 0,
		message: selected?.job.message ?? "Preparing…",
		activityMessage: executing?.job.message ?? "Preparing…",
		error: stopped > ready,
		percent: totalStages ? Math.round((100 * stageWork) / totalStages) : 0,
		key: runs.map((r) => r.id).join(":"),
	};
}
