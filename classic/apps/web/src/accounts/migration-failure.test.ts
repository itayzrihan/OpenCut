import { test, expect } from "bun:test";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	readdir,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountScope,
	registerAccount,
	accountDataRoot,
	markAccountImport,
	importLocked,
} from "./server";
import { importLegacyAccount } from "./migration";
import { migrationJob } from "./migration-jobs";

test("cancellation preserves originals; offline media and interrupted jobs recover completely", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-import-failure-"));
	const keys = [
		"OPENCUT_ACCOUNTS_DIR",
		"POCUT_PROJECTS_DIR",
		"OPENCUT_LEGACY_PUBLIC_DIR",
	] as const;
	const previous = keys.map((key) => process.env[key]);
	keys.forEach((key, index) => {
		process.env[key] = join(root, String(index));
	});
	try {
		const legacy = process.env.POCUT_PROJECTS_DIR!;
		await mkdir(join(legacy, "projects", "one", "media"), { recursive: true });
		const project = join(legacy, "projects", "one", "project.json"),
			index = join(legacy, "projects", "one", "media", "index.json");
		await writeFile(project, '{"id":"one","unknown":"retain"}');
		await writeFile(
			index,
			JSON.stringify([
				{
					id: "missing",
					storageKind: "linked",
					sourcePath: join(root, "missing.wav"),
				},
			]),
		);
		const { account } = await registerAccount({ login: "owner", displayName: "Owner", password: "a recovery test password" }
		);
		const destination = accountScope.run(account, accountDataRoot);
		await accountScope.run(account, async () => {
			const cancellation = new AbortController();
			cancellation.abort();
			await expect(
				importLegacyAccount({ onProgress: () => {}, signal: cancellation.signal }),
			).rejects.toThrow();
			expect(await readdir(destination).catch(() => [])).toEqual([]);
			expect(await readFile(project, "utf8")).toContain('"unknown":"retain"');
		});
		await accountScope.run(account, async () => {
			await markAccountImport({ id: account.id, active: true });
			expect(await importLocked(account.id)).toBe(true);
			await expect(markAccountImport({ id: account.id, active: true })).rejects.toThrow(
				"already running",
			);
			await markAccountImport({ id: account.id, active: false });
			expect(await importLocked(account.id)).toBe(false);
			await mkdir(join(process.env.OPENCUT_ACCOUNTS_DIR!, "import-jobs"), {
				recursive: true,
			});
			await writeFile(
				join(
					process.env.OPENCUT_ACCOUNTS_DIR!,
					"import-jobs",
					`${account.id}.json`,
				),
				JSON.stringify({ status: "running", files: 1, total: 2 }),
			);
			expect(await migrationJob()).toMatchObject({
				status: "failed",
				files: 1,
			});
			await importLegacyAccount({  });
			expect(await migrationJob()).toMatchObject({
				status: "complete",
				files: 2,
			});
			const receipt = JSON.parse(
				await readFile(
					join(accountDataRoot(), "migration-receipt.json"),
					"utf8",
				),
			);
			expect(receipt.version).toBe(2);
			expect(receipt.activated).toHaveLength(2);
			expect(receipt.missing).toHaveLength(1);
			expect(
				await readFile(
					join(destination, "projects", "one", "media", "index.json"),
					"utf8",
				),
			).toBe(await readFile(index, "utf8"));
		});
	} finally {
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
		await rm(root, { recursive: true, force: true });
	}
});
