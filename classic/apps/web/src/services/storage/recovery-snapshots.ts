import { IndexedDBAdapter } from "./indexeddb-adapter";
import { LocalDriveJsonAdapter } from "@/services/local-drive/adapters";
import type { ProjectRecord } from "./migrations/transformers/types";

export const PROJECT_RECOVERY_DB_NAME = "video-editor-project-recovery";
export const PROJECT_RECOVERY_STORE_NAME = "project-snapshots";
export const MAX_PROJECT_RECOVERY_SNAPSHOTS = 50;

export type ProjectRecoverySnapshotReason =
	| "migration"
	| "overwrite"
	| "delete";

export interface ProjectRecoverySnapshotRecord {
	id: string;
	schemaVersion: 1;
	reason: ProjectRecoverySnapshotReason;
	projectId: string;
	projectName: string | null;
	sourceVersion: number;
	targetVersion: number | null;
	createdAt: number;
	project: ProjectRecord;
}

export interface ProjectRecoverySnapshotStorage {
	list(): Promise<string[]>;
	set({
		key,
		value,
	}: {
		key: string;
		value: ProjectRecoverySnapshotRecord;
	}): Promise<void>;
	remove(key: string): Promise<void>;
}

function getCreatedAtFromSnapshotId(id: string): number {
	const separatorIndex = id.indexOf(":");
	if (separatorIndex < 1) {
		return Number.NEGATIVE_INFINITY;
	}

	const createdAt = Number(id.slice(0, separatorIndex));
	return Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
}

function createDefaultStorage(): ProjectRecoverySnapshotStorage {
	return new LocalDriveJsonAdapter<ProjectRecoverySnapshotRecord>({
		collection: "recovery-snapshots",
		legacy: new IndexedDBAdapter<ProjectRecoverySnapshotRecord>({
			dbName: PROJECT_RECOVERY_DB_NAME,
			storeName: PROJECT_RECOVERY_STORE_NAME,
			version: 1,
		}),
	});
}

function createSnapshotId({
	projectId,
	createdAt,
}: {
	projectId: string;
	createdAt: number;
}): string {
	const nonce = globalThis.crypto.randomUUID();
	return `${createdAt}:${projectId}:${nonce}`;
}

/**
 * Persists an immutable raw project record before a destructive storage write.
 *
 * The snapshot lives in the local-drive recovery collection. Retention cleanup is
 * part of the operation: if either the snapshot commit or cleanup fails, this
 * rejects so the caller can leave the live project untouched.
 */
export async function persistProjectRecoverySnapshot({
	reason,
	projectId,
	projectName,
	sourceVersion,
	targetVersion = null,
	project,
	storage = createDefaultStorage(),
	maxSnapshots = MAX_PROJECT_RECOVERY_SNAPSHOTS,
	now = Date.now,
	createId = createSnapshotId,
}: {
	reason: ProjectRecoverySnapshotReason;
	projectId: string;
	projectName: string | null;
	sourceVersion: number;
	targetVersion?: number | null;
	project: ProjectRecord;
	storage?: ProjectRecoverySnapshotStorage;
	maxSnapshots?: number;
	now?: () => number;
	createId?: (args: { projectId: string; createdAt: number }) => string;
}): Promise<ProjectRecoverySnapshotRecord> {
	const createdAt = now();
	const id = createId({ projectId, createdAt });
	const snapshot: ProjectRecoverySnapshotRecord = {
		id,
		schemaVersion: 1,
		reason,
		projectId,
		projectName,
		sourceVersion,
		targetVersion,
		createdAt,
		project: structuredClone(project),
	};

	await storage.set({ key: id, value: snapshot });

	const retentionLimit = Number.isFinite(maxSnapshots)
		? Math.max(1, Math.floor(maxSnapshots))
		: MAX_PROJECT_RECOVERY_SNAPSHOTS;
	const snapshotIds = new Set(await storage.list());
	snapshotIds.add(id);

	const snapshotIdsToRemove = [...snapshotIds]
		.sort(
			(a, b) =>
				getCreatedAtFromSnapshotId(a) - getCreatedAtFromSnapshotId(b) ||
				a.localeCompare(b),
		)
		.slice(0, Math.max(0, snapshotIds.size - retentionLimit));

	for (const snapshotId of snapshotIdsToRemove) {
		await storage.remove(snapshotId);
	}

	return snapshot;
}
