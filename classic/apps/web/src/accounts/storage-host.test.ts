import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rename,
	readdir,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, accountDataRoot, registerAccount } from "./server";
import {
	configureStorageFolder,
	publishAccountSnapshot,
	restoreAccountSnapshot,
	listAccountSnapshots,
	accountSnapshotNeeded,
	readStorageConnection,
	readStorageProfile,
	type StoragePolicy,
} from "./storage-host";

// This suite tests filesystem/crypto adapters; account-core tests exercise the
// real portable validation policy, and HTTP tests exercise its WASM projection.
const policy: StoragePolicy = {
	configure: ({ stateJson, configurationJson }) =>
		JSON.stringify({
			...JSON.parse(stateJson),
			storage: JSON.parse(configurationJson),
		}),
	validate: ({ manifestJson, authenticatedId }) => {
		if (JSON.parse(manifestJson).accountId !== authenticatedId)
			throw new Error("Account mismatch");
	},
};

test("offline sources survive encrypted snapshots and metadata-only restore preserves the full version", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-offline-vault-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = join(root, "host");
	try {
		const { account } = await registerAccount(
			"offline-owner",
			"Offline Owner",
			"offline testing password",
		);
		await mkdir(join(root, "external"));
		await accountScope.run(account, async () => {
			const data = accountDataRoot();
			await mkdir(join(data, "projects", "one", "media", "files"), {
				recursive: true,
			});
			const index = [
				{
					id: "missing",
					storageKind: "linked",
					sourcePath: join(root, "missing.mp4"),
					duration: 20,
				},
				{
					id: "present",
					storageKind: "copied",
					storedPath: "media/files/present.wav",
				},
			];
			await writeFile(
				join(data, "projects", "one", "media", "index.json"),
				JSON.stringify(index),
			);
			await writeFile(
				join(data, "projects", "one", "project.json"),
				'{"keep":"all edits"}',
			);
			await writeFile(
				join(data, "projects", "one", "media", "files", "present.wav"),
				"media bytes",
			);
			await configureStorageFolder(join(root, "external"), policy, true);
			const snapshot = await publishAccountSnapshot(policy);
			expect(await accountSnapshotNeeded()).toBe(false);
			const restored = await restoreAccountSnapshot(
				snapshot.snapshotId,
				policy,
				undefined,
				undefined,
				true,
				true,
			);
			expect(restored.deferredMedia).toBe(1);
			expect(
				JSON.parse(
					await readFile(
						join(data, "projects", "one", "media", "index.json"),
						"utf8",
					),
				),
			).toEqual(index);
			await expect(
				readFile(
					join(data, "projects", "one", "media", "files", "present.wav"),
				),
			).rejects.toThrow();
			await restoreAccountSnapshot(
				snapshot.snapshotId,
				policy,
				undefined,
				undefined,
				true,
			);
			expect(
				await readFile(
					join(data, "projects", "one", "media", "files", "present.wav"),
					"utf8",
				),
			).toBe("media bytes");
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
test("encrypted incremental snapshots restore exact bytes and reject damaged objects without replacing local data", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-vault-")),
		previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = join(root, "host");
	try {
		const { account } = await registerAccount(
			"snapshot-owner",
			"Snapshot Owner",
			"snapshot adapter test password",
		);
		await mkdir(join(root, "external"));
		await accountScope.run(account, async () => {
			const data = accountDataRoot();
			await mkdir(join(data, "projects", "one"), { recursive: true });
			const original =
				'{"metadata":{"id":"one"},"unknownFields":{"preserve":true}}';
			await writeFile(join(data, "projects", "one", "project.json"), original);
			await writeFile(join(data, "empty.bin"), "");
			await configureStorageFolder(join(root, "external"), policy, true);
			expect(await accountSnapshotNeeded()).toBe(true);
			const first = await publishAccountSnapshot(policy),
				second = await publishAccountSnapshot(policy);
			expect(await accountSnapshotNeeded()).toBe(false);
			expect(first.snapshotId).not.toBe(second.snapshotId);
			const vault = join(root, "external", "OpenCut Vaults", account.id);
			expect(await readdir(join(vault, "objects"))).toHaveLength(2);
			expect(await listAccountSnapshots(policy)).toHaveLength(2);
			await expect(
				publishAccountSnapshot(policy, (done) => {
					if (done === 1)
						writeFileSync(
							join(data, "projects", "one", "project.json"),
							"edits made while encrypting",
						);
				}),
			).rejects.toThrow();
			expect(await listAccountSnapshots(policy)).toHaveLength(2);
			expect(
				await readFile(join(data, "projects", "one", "project.json"), "utf8"),
			).toBe("edits made while encrypting");
			await writeFile(join(data, "projects", "one", "project.json"), original);
			const sealed = await readFile(
				join(vault, "snapshots", `${first.snapshotId}.manifest`),
			);
			expect(sealed.includes(Buffer.from("project.json"))).toBe(false);
			await expect(
				restoreAccountSnapshot(first.snapshotId, policy),
			).rejects.toThrow("empty workspace");
			await rename(data, `${data}.original`);
			await restoreAccountSnapshot(first.snapshotId, policy);
			expect(
				await readFile(join(data, "projects", "one", "project.json"), "utf8"),
			).toBe(original);
			expect((await readFile(join(data, "empty.bin"))).length).toBe(0);
			await writeFile(
				join(data, "projects", "one", "project.json"),
				"new local work",
			);
			expect(await accountSnapshotNeeded()).toBe(true);
			const switched = await restoreAccountSnapshot(
				first.snapshotId,
				policy,
				undefined,
				undefined,
				true,
			);
			expect(switched.savedCurrent).toBeDefined();
			expect(
				await readFile(join(data, "projects", "one", "project.json"), "utf8"),
			).toBe(original);
			await restoreAccountSnapshot(
				switched.savedCurrent!,
				policy,
				undefined,
				undefined,
				true,
			);
			expect(
				await readFile(join(data, "projects", "one", "project.json"), "utf8"),
			).toBe("new local work");
			const cancelled = new AbortController();
			cancelled.abort();
			await expect(
				restoreAccountSnapshot(
					first.snapshotId,
					policy,
					undefined,
					cancelled.signal,
					true,
				),
			).rejects.toThrow();
			expect(
				await readFile(join(data, "projects", "one", "project.json"), "utf8"),
			).toBe("new local work");
			await rename(data, `${data}.restored`);
			const entry = first.files.find((file) => file.bytes > 0)!;
			const objectPath = join(vault, "objects", `${entry.sha256}.blob`),
				bytes = await readFile(objectPath);
			bytes[20] ^= 0xff;
			await writeFile(objectPath, bytes);
			await expect(
				restoreAccountSnapshot(first.snapshotId, policy),
			).rejects.toThrow();
			expect(await readdir(data).catch(() => [])).toEqual([]);
			expect(
				await readFile(
					join(`${data}.original`, "projects", "one", "project.json"),
					"utf8",
				),
			).toBe(original);
			await rename(join(root, "external"), join(root, "unplugged"));
			expect((await readStorageConnection(policy)).status).toBe("unavailable");
			expect((await readStorageProfile()).folder).toBe(join(root, "external"));
			await configureStorageFolder(null, policy, false, { mode: "localOnly" });
			expect((await readStorageConnection(policy)).status).toBe("local");
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
