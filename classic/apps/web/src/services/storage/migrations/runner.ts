import {
	IndexedDBAdapter,
	deleteDatabase,
} from "@/services/storage/indexeddb-adapter";
import type { StorageMigration } from "./base";
import { persistProjectMigrationBackup } from "./migration-backups";
import type { ProjectRecord } from "./transformers/types";
import { getProjectId, isRecord } from "./transformers/utils";

export interface StorageMigrationResult {
	migratedCount: number;
	failures: StorageMigrationFailure[];
}

export type StorageMigrationFailureStage = "backup" | "migration" | "persist";

export interface StorageMigrationFailure {
	projectId: string;
	projectName: string | null;
	sourceVersion: number;
	currentVersion: number;
	targetVersion: number;
	stage: StorageMigrationFailureStage;
	migration: { from: number; to: number } | null;
	message: string;
	error: unknown;
}

export interface MigrationProgress {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

let hasCleanedUpMetaDb = false;

const MIN_MIGRATION_DISPLAY_MS = 1000;

interface ProjectsMigrationStorage {
	getAll(): Promise<ProjectRecord[]>;
	set({ key, value }: { key: string; value: ProjectRecord }): Promise<void>;
}

export interface StorageMigrationRunnerDependencies {
	projectsStorage: ProjectsMigrationStorage;
	persistBackup: typeof persistProjectMigrationBackup;
	cleanupLegacyMetaDatabase: () => Promise<void>;
	now: () => number;
	wait: (milliseconds: number) => Promise<void>;
	minimumDisplayMs: number;
}

async function cleanupLegacyMetaDatabase(): Promise<void> {
	if (hasCleanedUpMetaDb) {
		return;
	}

	try {
		await deleteDatabase({ dbName: "video-editor-meta" });
	} catch {
		// Ignore errors - DB might not exist.
	}
	hasCleanedUpMetaDb = true;
}

function createDefaultDependencies(): StorageMigrationRunnerDependencies {
	return {
		projectsStorage: new IndexedDBAdapter<ProjectRecord>({
			dbName: "video-editor-projects",
			storeName: "projects",
			version: 1,
		}),
		persistBackup: persistProjectMigrationBackup,
		cleanupLegacyMetaDatabase,
		now: Date.now,
		wait: (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
		minimumDisplayMs: MIN_MIGRATION_DISPLAY_MS,
	};
}

export async function runStorageMigrations({
	migrations,
	onProgress,
	dependencies = createDefaultDependencies(),
}: {
	migrations: StorageMigration[];
	onProgress?: (progress: MigrationProgress) => void;
	/** @internal Dependency overrides are exported for focused runner tests. */
	dependencies?: StorageMigrationRunnerDependencies;
}): Promise<StorageMigrationResult> {
	let migratedCount = 0;
	let migrationStartTime: number | null = null;
	const failures: StorageMigrationFailure[] = [];

	try {
		await dependencies.cleanupLegacyMetaDatabase();
		const projects = await dependencies.projectsStorage.getAll();
		const orderedMigrations = [...migrations].sort((a, b) => a.from - b.from);

		for (const project of projects) {
			if (!isRecord(project)) {
				continue;
			}

			let projectRecord = project;
			const projectId = getProjectId({ project: projectRecord });
			if (!projectId) {
				continue;
			}

			const sourceVersion = getProjectVersion({ project: projectRecord });
			let currentVersion = sourceVersion;
			const targetVersion = orderedMigrations.at(-1)?.to ?? currentVersion;

			if (currentVersion >= targetVersion) {
				continue;
			}

			if (migrationStartTime === null) {
				migrationStartTime = dependencies.now();
			}

			const projectName = getProjectName({ project: projectRecord });
			onProgress?.({
				isMigrating: true,
				fromVersion: currentVersion,
				toVersion: targetVersion,
				projectName,
			});

			try {
				await dependencies.persistBackup({
					projectId,
					projectName,
					sourceVersion,
					targetVersion,
					project: projectRecord,
				});
			} catch (error) {
				failures.push(
					createFailure({
						projectId,
						projectName,
						sourceVersion,
						currentVersion,
						targetVersion,
						stage: "backup",
						migration: null,
						error,
					}),
				);
				continue;
			}

			let projectFailed = false;
			for (const migration of orderedMigrations) {
				if (migration.from !== currentVersion) {
					continue;
				}

				let result;
				try {
					result = await migration.run({
						projectId,
						project: projectRecord,
					});
				} catch (error) {
					failures.push(
						createFailure({
							projectId,
							projectName,
							sourceVersion,
							currentVersion,
							targetVersion,
							stage: "migration",
							migration,
							error,
						}),
					);
					projectFailed = true;
					break;
				}

				if (result.skipped) {
					const error = new Error(
						result.reason ??
							`Migration ${migration.from}→${migration.to} skipped the project`,
					);
					failures.push(
						createFailure({
							projectId,
							projectName,
							sourceVersion,
							currentVersion,
							targetVersion,
							stage: "migration",
							migration,
							error,
						}),
					);
					projectFailed = true;
					break;
				}

				try {
					await dependencies.projectsStorage.set({
						key: projectId,
						value: result.project,
					});
				} catch (error) {
					failures.push(
						createFailure({
							projectId,
							projectName,
							sourceVersion,
							currentVersion,
							targetVersion,
							stage: "persist",
							migration,
							error,
						}),
					);
					projectFailed = true;
					break;
				}

				migratedCount++;
				currentVersion = migration.to;
				projectRecord = result.project;
			}

			if (!projectFailed && currentVersion < targetVersion) {
				const error = new Error(
					`No storage migration is registered from project version ${currentVersion}`,
				);
				failures.push(
					createFailure({
						projectId,
						projectName,
						sourceVersion,
						currentVersion,
						targetVersion,
						stage: "migration",
						migration: null,
						error,
					}),
				);
			}
		}

		return { migratedCount, failures };
	} finally {
		try {
			if (migrationStartTime !== null) {
				const elapsed = dependencies.now() - migrationStartTime;
				if (elapsed < dependencies.minimumDisplayMs) {
					await dependencies.wait(dependencies.minimumDisplayMs - elapsed);
				}
			}
		} finally {
			onProgress?.({
				isMigrating: false,
				fromVersion: null,
				toVersion: null,
				projectName: null,
			});
		}
	}
}

function createFailure({
	projectId,
	projectName,
	sourceVersion,
	currentVersion,
	targetVersion,
	stage,
	migration,
	error,
}: Omit<StorageMigrationFailure, "message" | "migration"> & {
	migration: Pick<StorageMigration, "from" | "to"> | null;
}): StorageMigrationFailure {
	return {
		projectId,
		projectName,
		sourceVersion,
		currentVersion,
		targetVersion,
		stage,
		migration: migration ? { from: migration.from, to: migration.to } : null,
		message: error instanceof Error ? error.message : String(error),
		error,
	};
}

function getProjectVersion({ project }: { project: ProjectRecord }): number {
	const versionValue = project.version;

	// v2 and up - has explicit version field
	if (typeof versionValue === "number") {
		return versionValue;
	}

	// v1 - has scenes array
	const scenesValue = project.scenes;
	if (Array.isArray(scenesValue) && scenesValue.length > 0) {
		return 1;
	}

	// v0 - no scenes
	return 0;
}

function getProjectName({
	project,
}: {
	project: ProjectRecord;
}): string | null {
	const metadata = project.metadata;
	if (isRecord(metadata) && typeof metadata.name === "string") {
		return metadata.name;
	}

	// v0 had name directly on project
	if (typeof project.name === "string") {
		return project.name;
	}

	return null;
}
