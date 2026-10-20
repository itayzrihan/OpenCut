import type { BatchRun } from "./types";
import { queueOwner } from "./scene-jobs";

export function sceneWorkerUrl() {
	return `/batch-worker?owner=${encodeURIComponent(queueOwner())}`;
}

/** Called directly by the user's enqueue/retry gesture. No editor credentials
 * enter the URL: the authenticated host issues a bounded lease to this runner. */
export function openSceneWorker({ runs = [] }: { runs?: BatchRun[] } = {}) {
	if (
		runs.some(
			(run) =>
				run.executor === "window" &&
				run.workerHeartbeatAt &&
				Date.now() - run.workerHeartbeatAt < 180_000 &&
				run.jobs.some((job) => ["ready", "running"].includes(job.status)),
		)
	)
		return;
	window.open(
		sceneWorkerUrl(),
		"_blank",
		"noopener,popup,width=480,height=320",
	);
}
