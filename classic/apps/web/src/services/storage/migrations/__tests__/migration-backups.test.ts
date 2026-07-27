import { describe, expect, test } from "bun:test";
import {
	persistProjectMigrationBackup,
	type ProjectMigrationBackupRecord,
	type ProjectMigrationBackupStorage,
} from "../migration-backups";

class MemoryBackupStorage implements ProjectMigrationBackupStorage {
	readonly records = new Map<string, ProjectMigrationBackupRecord>();

	async list(): Promise<string[]> {
		return [...this.records.keys()];
	}

	async set({
		key,
		value,
	}: {
		key: string;
		value: ProjectMigrationBackupRecord;
	}): Promise<void> {
		this.records.set(key, value);
	}

	async remove(key: string): Promise<void> {
		this.records.delete(key);
	}
}

describe("persistProjectMigrationBackup", () => {
	test("stores an independent raw snapshot and prunes the oldest backups", async () => {
		const storage = new MemoryBackupStorage();
		const originalProject = {
			id: "project-1",
			version: 0,
			metadata: { name: "Original" },
		};

		for (const sequence of [1, 2, 3]) {
			await persistProjectMigrationBackup({
				projectId: `project-${sequence}`,
				projectName: `Project ${sequence}`,
				sourceVersion: 0,
				targetVersion: 1,
				project:
					sequence === 1 ? originalProject : { id: `project-${sequence}` },
				storage,
				maxBackups: 2,
				now: () => sequence,
				createId: () => `backup-${sequence}`,
			});
		}

		originalProject.metadata.name = "Mutated after backup";

		expect([...storage.records.keys()]).toEqual(["backup-2", "backup-3"]);
		expect(storage.records.size).toBe(2);
	});

	test("retains the exact pre-migration record", async () => {
		const storage = new MemoryBackupStorage();
		const project = {
			id: "project-1",
			version: 7,
			metadata: { name: "Recover me" },
		};

		const backup = await persistProjectMigrationBackup({
			projectId: "project-1",
			projectName: "Recover me",
			sourceVersion: 7,
			targetVersion: 33,
			project,
			storage,
			now: () => 123,
			createId: () => "backup-1",
		});
		project.metadata.name = "Changed";

		expect(backup).toMatchObject({
			id: "backup-1",
			projectId: "project-1",
			sourceVersion: 7,
			targetVersion: 33,
			createdAt: 123,
			project: {
				id: "project-1",
				version: 7,
				metadata: { name: "Recover me" },
			},
		});
	});
});
