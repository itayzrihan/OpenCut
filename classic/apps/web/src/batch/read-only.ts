/** Read-only lock cache from the host queue; never a second project document. */
const locked = new Set<string>();
const preparing = new Set<string>();
// A viewer may outlive its route. Releasing the server lease does not make its
// last preview safe to save: only a fresh full project load can do that.
const stale = new Set<string>();
const versions = new Map<string, number>();
export function automationReadVersion(projectId: string) {
	return versions.get(projectId) ?? 0;
}
export function acknowledgeAutomationReload({
	projectId,
	version,
}: {
	projectId: string;
	version: number;
}) {
	if (!locked.has(projectId) && automationReadVersion(projectId) === version)
		stale.delete(projectId);
}
export function beginAutomationHandoff(projectId: string) {
	assertBatchEditable(projectId);
	preparing.add(projectId);
	return () => preparing.delete(projectId);
}
export function setBatchReadOnlyProjects(ids: string[]) {
	const next = new Set(ids);
	for (const id of new Set([...locked, ...next])) {
		if (locked.has(id) !== next.has(id)) {
			versions.set(id, automationReadVersion(id) + 1);
			stale.add(id);
		}
	}
	locked.clear();
	for (const id of ids) locked.add(id);
}
export function isBatchReadOnly(projectId: string | undefined) {
	return !!projectId && (locked.has(projectId) || stale.has(projectId));
}
export function assertBatchEditable(projectId: string | undefined) {
	if (isBatchReadOnly(projectId) || (!!projectId && preparing.has(projectId)))
		throw new Error(
			"This project is read-only while Full Auto Edit is working",
		);
}
