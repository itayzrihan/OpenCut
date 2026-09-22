/** Read-only lock cache from the host queue; never a second project document. */
const locked = new Set<string>();
export function setBatchReadOnlyProjects(ids: string[]) {
	locked.clear();
	for (const id of ids) locked.add(id);
}
export function isBatchReadOnly(projectId: string | undefined) {
	return !!projectId && locked.has(projectId);
}
export function assertBatchEditable(projectId: string | undefined) {
	if (isBatchReadOnly(projectId))
		throw new Error(
			"This project is read-only while Batch Full Auto Edit is working",
		);
}
