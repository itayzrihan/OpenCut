import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { RenderJob, RenderQueueView } from "./types";

export type State = { revision: number; renderQueue: RenderJob[] };

export function edit(
	runtime: CanonicalEditorRuntime,
	state: State,
	id: string,
	projectId: string,
	change: Record<string, unknown>,
	requestId?: string,
): RenderJob {
	const result = runtime.invokeSync(
		"render.queue.edit",
		{
			projectId,
			expectedRevision: state.revision,
			id,
			nowMs: Date.now(),
			change,
		},
		{ metadata: requestId ? { "opencut/idempotencyKey": requestId } : {} },
	) as { result: { data: { job: RenderJob } } };
	return result.result.data.job;
}

export function view(state: State): RenderQueueView {
	return {
		revision: state.revision,
		jobs: state.renderQueue.map(({ snapshot, attempt: _attempt, ...job }) => ({
			...job,
			projectName: snapshot.document.metadata.name,
			sceneName:
				snapshot.document.scenes.find((scene) => scene.id === job.sceneId)
					?.name ?? "Scene",
		})),
	};
}

export function releaseQueue(runtime: CanonicalEditorRuntime, state: State) {
	if (
		state.renderQueue.some(
			(job) =>
				job.delivery === "queue" && job.status === "queued" && !job.released,
		)
	) {
		runtime.invokeSync(
			"render.queue.start",
			{ expectedRevision: state.revision, nowMs: Date.now() },
			undefined,
		);
		return view(runtime.snapshot() as State);
	}
	return view(state);
}

export function nextRender({
	runtime,
	state,
	jobId,
}: {
	runtime: CanonicalEditorRuntime;
	state: State;
	jobId?: string;
}) {
	const active = state.renderQueue.find((job) => job.status === "rendering");
	if (active && Date.now() - active.updatedAtMs <= 120000) return null;
	if (active) {
		edit(runtime, state, active.id, active.projectId, {
			type: "report",
			attempt: active.attempt,
			progress: active.progress,
			message: "Renderer disconnected; retry uses the original snapshot",
			status: active.cancelRequested ? "cancelled" : "failed",
		});
		state = runtime.snapshot() as State;
	}
	const job = state.renderQueue.find(
		(job) =>
			job.status === "queued" &&
			(jobId
				? job.id === jobId && job.delivery === "direct"
				: job.delivery === "queue" && job.released),
	);
	return job ? { job, state } : null;
}

export function hasReleasedRenders(state: RenderQueueView) {
	return state.jobs.some(
		(job) =>
			job.delivery === "queue" &&
			(job.status === "rendering" || (job.status === "queued" && job.released)),
	);
}
