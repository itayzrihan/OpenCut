import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Recover the small atomic-activation window after a host crash. Never replace
// a present workspace, and never follow paths outside the authenticated host.
export async function recoverInterruptedRestores(
	root: string,
	accountId: string,
) {
	const directory = join(root, "restore-journals"),
		destination = join(root, "data", accountId);
	const entries = await readdir(directory).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const exists = (path: string) =>
		stat(path)
			.then(() => true)
			.catch((error) => {
				if (error.code === "ENOENT") return false;
				throw error;
			});
	for (const file of entries.filter(
		(name) => name.startsWith(`${accountId}-`) && name.endsWith(".json"),
	)) {
		const path = join(directory, file),
			journal = JSON.parse(await readFile(path, "utf8"));
		if (journal.status !== "prepared") continue;
		if (
			journal.destination !== destination ||
			typeof journal.retained !== "string" ||
			typeof journal.staging !== "string"
		)
			throw new Error("Invalid restore recovery journal");
		for (const candidate of [journal.retained, journal.staging]) {
			const rel = relative(root, resolve(candidate));
			if (!rel || rel.startsWith("..") || isAbsolute(rel))
				throw new Error("Restore journal escaped account storage");
		}
		if (
			!journal.retained.startsWith(`${destination}.before-restore-`) ||
			!journal.staging.startsWith(`${join(root, "restores", accountId)}-`)
		)
			throw new Error("Restore journal account mismatch");
		let status = "complete-after-restart";
		if (!(await exists(destination))) {
			const originalExists = await exists(journal.retained);
			const source = originalExists ? journal.retained : journal.staging;
			if (!(await exists(source)))
				throw new Error(
					"Restore recovery files are unavailable. Reconnect the account storage disk.",
				);
			await rename(source, destination).catch(async (error) => {
				if (!(await exists(destination))) throw error;
			});
			status = originalExists
				? "rolled-back-after-restart"
				: "complete-after-restart";
		}
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({ ...journal, status }));
		await rename(temporary, path);
	}
}
