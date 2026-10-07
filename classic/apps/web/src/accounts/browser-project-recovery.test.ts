import { test, expect, mock } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope, accountDataRoot, registerAccount } from "./server";
mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
}));

test("browser recovery preserves original disk bytes and exact browser inputs, and refuses conflicting retries", async () => {
	const { prepareBrowserProjectRecovery } =
		await import("./browser-project-recovery");
	const root = await mkdtemp(join(tmpdir(), "opencut-browser-recovery-")),
		previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	try {
		const { account } = await registerAccount({ login: "browser-owner", displayName: "Browser Owner", password: "browser recovery test password" }
		);
		await accountScope.run(account, async () => {
			const source = join(accountDataRoot(), "projects", "old");
			await mkdir(join(source, "media", "files"), { recursive: true });
			const original =
				'{"metadata":{"id":"old","name":"Disk edits"},"unrecognized":42}';
			await writeFile(join(source, "project.json"), original);
			await writeFile(
				join(source, "media", "files", "sample.wav"),
				Buffer.from([1, 2, 3, 4]),
			);
			const browser = {
					metadata: { id: "old", name: "Browser edits" },
					future: true,
				},
				history = { projectId: "old", undoStack: [{ keep: true }] };
			// Rust's projection is tested in the storage crate and the HTTP smoke.
			const projection = () =>
				JSON.stringify({
					project: {
						...browser,
						metadata: { id: "new", name: "Browser edits (browser recovery)" },
					},
					history: { ...history, projectId: "new" },
				});
			await prepareBrowserProjectRecovery({ sourceId: "old", destinationId: "new", project: browser, history: history, media: [{ id: "media" }], fonts: [], projection: projection }
			);
			expect(await readFile(join(source, "project.json"), "utf8")).toBe(
				original,
			);
			const target = join(accountDataRoot(), "projects", "new");
			expect(
				await readFile(join(target, "media", "files", "sample.wav")),
			).toEqual(Buffer.from([1, 2, 3, 4]));
			expect(
				JSON.parse(
					await readFile(
						join(target, "browser-originals", "project.json"),
						"utf8",
					),
				),
			).toEqual(browser);
			expect(
				JSON.parse(
					await readFile(
						join(target, "browser-originals", "history.json"),
						"utf8",
					),
				),
			).toEqual(history);
			await expect(
				prepareBrowserProjectRecovery({ sourceId: "old", destinationId: "new", project: browser, history: history, media: [{ id: "media" }], fonts: [], projection: projection }
				),
			).resolves.toEqual({ projectId: "new" });
			await expect(
				prepareBrowserProjectRecovery({ sourceId: "old", destinationId: "new", project: { ...browser, changed: true }, history: history, media: [], fonts: [], projection: projection }
				),
			).rejects.toThrow("source changed");
			await expect(
				prepareBrowserProjectRecovery({ sourceId: "old", destinationId: "../outside", project: browser, history: history, media: [], fonts: [], projection: projection }
				),
			).rejects.toThrow("Invalid");
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
