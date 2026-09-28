import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverInterruptedRestores } from "./restore-recovery";

test("a crash between workspace renames restores the previous workspace and retains verified incoming files", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-restore-crash-"));
	try {
		const destination = join(root, "data", "alice"),
			retained = `${destination}.before-restore-one`,
			staging = join(root, "restores", "alice-one"),
			journal = join(root, "restore-journals", "alice-one.json");
		await mkdir(retained, { recursive: true });
		await mkdir(staging, { recursive: true });
		await mkdir(join(root, "restore-journals"));
		await writeFile(join(retained, "project.json"), "previous unsent edits");
		await writeFile(join(staging, "project.json"), "verified incoming edits");
		await writeFile(
			journal,
			JSON.stringify({ status: "prepared", destination, retained, staging }),
		);
		await recoverInterruptedRestores(root, "bob");
		expect(await readFile(join(retained, "project.json"), "utf8")).toBe(
			"previous unsent edits",
		);
		await recoverInterruptedRestores(root, "alice");
		expect(await readFile(join(destination, "project.json"), "utf8")).toBe(
			"previous unsent edits",
		);
		expect(await readFile(join(staging, "project.json"), "utf8")).toBe(
			"verified incoming edits",
		);
		expect(JSON.parse(await readFile(journal, "utf8")).status).toBe(
			"rolled-back-after-restart",
		);
		await recoverInterruptedRestores(root, "alice");
		expect(await readFile(join(destination, "project.json"), "utf8")).toBe(
			"previous unsent edits",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
