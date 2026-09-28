import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, registerAccount, accountDataRoot } from "./server";
import { importLegacyAccount, inspectLegacyImport, hashFile } from "./migration";

test("legacy import copies unknown fields, history, settings, private assets and linked media without changing originals", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-import-"));
	const keys = ["OPENCUT_ACCOUNTS_DIR", "POCUT_PROJECTS_DIR", "OPENCUT_LEGACY_PUBLIC_DIR"] as const;
	const old = keys.map((key) => process.env[key]);
	keys.forEach((key, index) => { process.env[key] = join(root, String(index)); });
	try {
		const legacy = process.env.POCUT_PROJECTS_DIR!, library = process.env.OPENCUT_LEGACY_PUBLIC_DIR!;
		await mkdir(join(legacy, "projects", "project-1", "media"), { recursive: true });
		await mkdir(join(legacy, "settings"), { recursive: true });
		await mkdir(join(library, "shared-library", "stickers"), { recursive: true });
		const project = { metadata: { id: "project-1", name: "Original" }, unknownFutureField: { preserved: true }, scenes: [{ privateUrl: "/shared-library/stickers/asset.png" }] };
		await writeFile(join(legacy, "projects", "project-1", "project.json"), JSON.stringify(project));
		await writeFile(join(legacy, "projects", "project-1", "history.json"), '{"undo":[{"future":"keep"}]}');
		await writeFile(join(legacy, "settings", "custom.json"), '{"custom":true}');
		await writeFile(join(library, "shared-library", "stickers", "asset.png"), "exact asset bytes");
		const media = join(root, "linked.wav");
		await writeFile(media, "exact linked media bytes");
		const indexPath = join(legacy, "projects", "project-1", "media", "index.json");
		await writeFile(indexPath, JSON.stringify([{ id: "media-1", storageKind: "linked", sourcePath: media, size: 24 }]));
		const before = await hashFile(indexPath);
		const alice = await registerAccount("alice", "Alice", "a strong migration password");
		const bob = await registerAccount("bob", "Bob", "another migration password");
		await expect(accountScope.run(bob.account, inspectLegacyImport)).rejects.toThrow("first account");
		await accountScope.run(alice.account, async () => {
			expect(await inspectLegacyImport()).toMatchObject({ projects: 1, files: 5, missing: [] });
			const result = await importLegacyAccount();
			expect(result).toMatchObject({ projects: 1, files: 6 });
			const destination = accountDataRoot();
			const actual = JSON.parse(await readFile(join(destination, "projects", "project-1", "project.json"), "utf8"));
			expect(actual.unknownFutureField).toEqual(project.unknownFutureField);
			expect(actual.scenes[0].privateUrl).toBe("/api/account-assets/shared-library/stickers/asset.png");
			expect(await readFile(join(destination, "migration-originals", "projects", "project-1", "project.json"), "utf8")).toBe(JSON.stringify(project));
			expect(await readFile(join(destination, "projects", "project-1", "media", "files", "media-1--linked.wav"), "utf8")).toBe("exact linked media bytes");
			expect(await readFile(join(destination, "settings", "custom.json"), "utf8")).toBe('{"custom":true}');
			expect(await hashFile(indexPath)).toBe(before);
			await expect(importLegacyAccount()).rejects.toThrow("empty account");
		});
	} finally {
		keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
		await rm(root, { recursive: true, force: true });
	}
});
