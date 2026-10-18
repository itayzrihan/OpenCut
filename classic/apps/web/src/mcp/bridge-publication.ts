import type { BridgeHeartbeat } from "@/accounts/bridge-snapshot-cache";
type Metadata = Omit<BridgeHeartbeat, "expectedRevision">;
/** Serialize document bytes only when the canonical projection changed. */
export function bridgePublication({
	sessionId,
	metadata,
	documentDirty,
	acknowledged,
	readDocument,
}: {
	sessionId: string;
	metadata: Metadata;
	documentDirty: boolean;
	acknowledged?: { projectId: string; revision: number };
	readDocument: () => Record<string, unknown>;
}) {
	const heartbeat =
		acknowledged !== undefined &&
		acknowledged.projectId === metadata.projectId &&
		!documentDirty;
	return heartbeat
		? {
				method: "POST",
				path: `/api/mcp-bridge/heartbeat/${encodeURIComponent(sessionId)}`,
				payload: { ...metadata, expectedRevision: acknowledged.revision },
			}
		: {
				method: "PUT",
				path: "/api/mcp-bridge/state",
				payload: { ...metadata, sessionId, ...readDocument() },
			};
}
