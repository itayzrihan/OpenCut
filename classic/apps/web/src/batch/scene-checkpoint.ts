import type { BatchRun } from "./types";

/** Legacy jobs without a scene are usable only before the first scene-scoped
 * handoff. Once a project has one, an older unscoped checkpoint is ambiguous. */
export function findSceneCheckpoint({
	runs,
	projectId,
	sceneId,
}: {
	runs: BatchRun[];
	projectId: string;
	sceneId?: string;
}) {
	const scoped = runs.some((run) =>
		run.jobs.some((job) => job.projectId === projectId && !!job.sceneId),
	);
	return runs.find((run) =>
		run.jobs.some(
			(job) =>
				job.projectId === projectId &&
				(job.sceneId === sceneId || (!scoped && !job.sceneId)),
		),
	);
}
