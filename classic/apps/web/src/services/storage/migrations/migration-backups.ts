import {
	MAX_PROJECT_RECOVERY_SNAPSHOTS,
	persistProjectRecoverySnapshot,
	type ProjectRecoverySnapshotRecord,
	type ProjectRecoverySnapshotStorage,
} from "@/services/storage/recovery-snapshots";
import type { ProjectRecord } from "./transformers/types";

export const MAX_PROJECT_MIGRATION_BACKUPS = MAX_PROJECT_RECOVERY_SNAPSHOTS;
export type ProjectMigrationBackupRecord = ProjectRecoverySnapshotRecord;
export type ProjectMigrationBackupStorage = ProjectRecoverySnapshotStorage;

/** Save the original raw record before the first write in a migration chain. */
export async function persistProjectMigrationBackup({
	projectId,
	projectName,
	sourceVersion,
	targetVersion,
	project,
	storage,
	maxBackups,
	now,
	createId,
}: {
	projectId: string;
	projectName: string | null;
	sourceVersion: number;
	targetVersion: number;
	project: ProjectRecord;
	storage?: ProjectMigrationBackupStorage;
	maxBackups?: number;
	now?: () => number;
	createId?: (args: { projectId: string; createdAt: number }) => string;
}): Promise<ProjectMigrationBackupRecord> {
	return persistProjectRecoverySnapshot({
		reason: "migration",
		projectId,
		projectName,
		sourceVersion,
		targetVersion,
		project,
		storage,
		maxSnapshots: maxBackups,
		now,
		createId,
	});
}
