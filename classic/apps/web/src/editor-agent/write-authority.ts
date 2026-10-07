export interface EditorWriteAuthority {
	sessionId: string;
	generation: number;
}
const owners = new Map<string, () => EditorWriteAuthority | null>();
const key = ({
	accountId,
	projectId,
}: {
	accountId: string;
	projectId: string;
}) => JSON.stringify([accountId, projectId]);

/** Transport cache only. The host checks every fence against the Rust store. */
export function bindEditorWriteAuthority({
	accountId,
	projectId,
	read,
}: {
	accountId: string;
	projectId: string;
	read: () => EditorWriteAuthority | null;
}) {
	const id = key({ accountId, projectId });
	owners.set(id, read);
	return () => {
		if (owners.get(id) === read) owners.delete(id);
	};
}

export function editorWriteHeaders({
	projectId,
	accountId = typeof window === "undefined"
		? "local"
		: (window.__opencutAccountId ?? "local"),
}: {
	projectId: unknown;
	accountId?: string;
}): Record<string, string> {
	if (typeof projectId !== "string") return {};
	const owner = owners.get(key({ accountId, projectId }))?.();
	return owner
		? {
				"X-OpenCut-Editor-Project": projectId,
				"X-OpenCut-Editor-Session": owner.sessionId,
				"X-OpenCut-Editor-Generation": String(owner.generation),
			}
		: {};
}
