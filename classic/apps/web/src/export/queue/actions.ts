import { renderQueueRequest } from "./client";
import type { RenderQueueView } from "./types";

/** Progress heartbeats can advance the queue revision between a click and POST.
 * Rebase only an unchanged target job; never replay a changed export draft. */
export async function changeQueuedRender({
	action,
	id,
	projectId,
	state,
}: {
	action: "retry" | "cancel";
	id: string;
	projectId: string;
	state: RenderQueueView;
}) {
	const original = state.jobs.find(
		(j) => j.id === id && j.projectId === projectId,
	);
	if (!original) throw Error("Render job is no longer available");
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await renderQueueRequest({
				action,
				id,
				projectId,
				expectedRevision: state.revision,
			});
		} catch (error) {
			if (!String(error).includes("Queue changed") || attempt === 3)
				throw error;
			state = await renderQueueRequest();
			const current = state.jobs.find(
				(j) => j.id === id && j.projectId === projectId,
			);
			if (
				!current ||
				current.snapshotHash !== original.snapshotHash ||
				current.status !== original.status
			)
				return state;
		}
	}
	throw Error("Queue changed; try again");
}
