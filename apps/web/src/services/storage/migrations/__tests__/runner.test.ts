import { describe, expect, test } from "bun:test";
import { StorageMigration } from "../base";
import {
	runStorageMigrations,
	type MigrationProgress,
	type StorageMigrationRunnerDependencies,
} from "../runner";
import type { MigrationResult, ProjectRecord } from "../transformers/types";

class TestMigration extends StorageMigration {
	from = 0;
	to = 1;

	constructor(
		private readonly execute: (args: {
			projectId: string;
			project: ProjectRecord;
		}) => Promise<MigrationResult<ProjectRecord>>,
	) {
		super();
	}

	async run({
		projectId,
		project,
	}: {
		projectId: string;
		project: ProjectRecord;
	}): Promise<MigrationResult<ProjectRecord>> {
		return this.execute({ projectId, project });
	}
}

function createProject({ id }: { id: string }): ProjectRecord {
	return {
		id,
		version: 0,
		metadata: { id, name: id },
	};
}

function createDependencies({
	projects,
	setProject = async () => undefined,
	persistBackup,
}: {
	projects: ProjectRecord[] | (() => Promise<ProjectRecord[]>);
	setProject?: StorageMigrationRunnerDependencies["projectsStorage"]["set"];
	persistBackup?: StorageMigrationRunnerDependencies["persistBackup"];
}): StorageMigrationRunnerDependencies {
	return {
		projectsStorage: {
			getAll: typeof projects === "function" ? projects : async () => projects,
			set: setProject,
		},
		persistBackup:
			persistBackup ??
			(async ({
				projectId,
				projectName,
				sourceVersion,
				targetVersion,
				project,
			}) => ({
				id: projectId,
				schemaVersion: 1,
				reason: "migration",
				projectId,
				projectName,
				sourceVersion,
				targetVersion,
				createdAt: 0,
				project,
			})),
		cleanupLegacyMetaDatabase: async () => undefined,
		now: () => 1_000,
		wait: async () => undefined,
		minimumDisplayMs: 0,
	};
}

function successfulMigration({
	project,
}: {
	project: ProjectRecord;
}): Promise<MigrationResult<ProjectRecord>> {
	return Promise.resolve({
		skipped: false,
		project: { ...project, version: 1 },
	});
}

describe("runStorageMigrations", () => {
	test("isolates a transformer failure and migrates the remaining projects", async () => {
		const writes: string[] = [];
		const progress: MigrationProgress[] = [];
		const migrationError = new Error("malformed tracks");
		const migration = new TestMigration(async ({ projectId, project }) => {
			if (projectId === "broken") {
				throw migrationError;
			}
			return successfulMigration({ project });
		});

		const result = await runStorageMigrations({
			migrations: [migration],
			onProgress: (value) => progress.push(value),
			dependencies: createDependencies({
				projects: [
					createProject({ id: "broken" }),
					createProject({ id: "good" }),
				],
				setProject: async ({ key }) => {
					writes.push(key);
				},
			}),
		});

		expect(writes).toEqual(["good"]);
		expect(result.migratedCount).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			projectId: "broken",
			stage: "migration",
			currentVersion: 0,
			message: "malformed tracks",
		});
		expect(result.failures[0]?.error).toBe(migrationError);
		expect(progress.at(-1)).toEqual({
			isMigrating: false,
			fromVersion: null,
			toVersion: null,
			projectName: null,
		});
	});

	test("does not touch a project whose recovery snapshot cannot be saved", async () => {
		const backedUp: string[] = [];
		const migrated: string[] = [];
		const writes: string[] = [];
		const migration = new TestMigration(async ({ projectId, project }) => {
			migrated.push(projectId);
			return successfulMigration({ project });
		});

		const result = await runStorageMigrations({
			migrations: [migration],
			dependencies: createDependencies({
				projects: [
					createProject({ id: "unsafe" }),
					createProject({ id: "safe" }),
				],
				persistBackup: async ({ projectId }) => {
					backedUp.push(projectId);
					if (projectId === "unsafe") {
						throw new Error("recovery database is full");
					}
					return {
						id: projectId,
						schemaVersion: 1,
						reason: "migration",
						projectId,
						projectName: null,
						sourceVersion: 0,
						targetVersion: 1,
						createdAt: 0,
						project: {},
					};
				},
				setProject: async ({ key }) => {
					writes.push(key);
				},
			}),
		});

		expect(backedUp).toEqual(["unsafe", "safe"]);
		expect(migrated).toEqual(["safe"]);
		expect(writes).toEqual(["safe"]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toMatchObject({
			projectId: "unsafe",
			stage: "backup",
			message: "recovery database is full",
		});
	});

	test("isolates a project write failure", async () => {
		const writes: string[] = [];
		const result = await runStorageMigrations({
			migrations: [new TestMigration(successfulMigration)],
			dependencies: createDependencies({
				projects: [
					createProject({ id: "unwritable" }),
					createProject({ id: "good" }),
				],
				setProject: async ({ key }) => {
					writes.push(key);
					if (key === "unwritable") {
						throw new Error("transaction aborted");
					}
				},
			}),
		});

		expect(writes).toEqual(["unwritable", "good"]);
		expect(result.migratedCount).toBe(1);
		expect(result.failures[0]).toMatchObject({
			projectId: "unwritable",
			stage: "persist",
			message: "transaction aborted",
		});
	});

	test("always clears progress when loading projects rejects", async () => {
		const progress: MigrationProgress[] = [];
		const loadError = new Error("IndexedDB is unavailable");
		const run = runStorageMigrations({
			migrations: [new TestMigration(successfulMigration)],
			onProgress: (value) => progress.push(value),
			dependencies: createDependencies({
				projects: async () => {
					throw loadError;
				},
			}),
		});

		await expect(run).rejects.toBe(loadError);
		expect(progress).toEqual([
			{
				isMigrating: false,
				fromVersion: null,
				toVersion: null,
				projectName: null,
			},
		]);
	});
});
