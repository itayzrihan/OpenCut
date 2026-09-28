import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, accountDataRoot, registerAccount, loginAccount } from "./server";
import { exportAccountIdentity, importAccountIdentity } from "./identity-transfer";
import { configureStorageFolder, publishAccountSnapshot, restoreAccountSnapshot, listAccountSnapshots, type StoragePolicy } from "./storage-host";
const policy: StoragePolicy = {
	configure: ({ stateJson, configurationJson }) => JSON.stringify({ ...JSON.parse(stateJson), storage: JSON.parse(configurationJson) }),
	validate: ({ manifestJson, authenticatedId }) => { if (JSON.parse(manifestJson).accountId !== authenticatedId) throw new Error("Account mismatch"); },
};
test("password-protected identity transfer opens encrypted snapshots on a second host without replacing an existing account", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-identity-")), previous = process.env.OPENCUT_ACCOUNTS_DIR;
	const password = "private recovery test password";
	try {
		process.env.OPENCUT_ACCOUNTS_DIR = join(root, "first-host");
		const { account } = await registerAccount("portable-account", "Portable Account", password);
		const folder = join(root, "mounted-drive"); await mkdir(folder);
		const { recovery, snapshot } = await accountScope.run(account, async () => {
			await mkdir(accountDataRoot(), { recursive: true }); await writeFile(join(accountDataRoot(), "settings.json"), '{"keep":"all settings"}');
			await configureStorageFolder(folder, policy);
			await expect(exportAccountIdentity("incorrect password")).rejects.toThrow("Invalid password");
			return { recovery: await exportAccountIdentity(password), snapshot: await publishAccountSnapshot(policy) };
		});
		expect(JSON.stringify(recovery)).not.toContain(account.id);
		process.env.OPENCUT_ACCOUNTS_DIR = join(root, "second-host");
		await expect(importAccountIdentity(recovery, "wrong recovery password")).rejects.toThrow("incorrect");
		const restored = await importAccountIdentity(recovery, password);
		expect(restored.account.id).toBe(account.id);
		await expect(importAccountIdentity(recovery, password)).rejects.toThrow("already exists");
		expect((await loginAccount(account.login, password)).account.id).toBe(account.id);
		await accountScope.run(restored.account, async () => {
			await configureStorageFolder(folder, policy);
			expect(await listAccountSnapshots(policy)).toHaveLength(1);
			await restoreAccountSnapshot(snapshot.snapshotId, policy);
			expect(await readFile(join(accountDataRoot(), "settings.json"), "utf8")).toBe('{"keep":"all settings"}');
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR; else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
