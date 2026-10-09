/** A UI guard populated from host acknowledgements. It never grants storage
 * authority; Rust validates the lease/fence on every durable mutation. */
const unavailable = new Map<string, string>();

export function setEditorOwnershipGuard({
	projectId,
	reason,
}: {
	projectId: string;
	reason: string | null;
}) {
	if (reason) unavailable.set(projectId, reason);
	else unavailable.delete(projectId);
}

export function assertEditorOwnership(projectId: string | undefined) {
	const reason = projectId ? unavailable.get(projectId) : undefined;
	if (reason) throw new Error(reason);
}
