import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountScope } from "@/accounts/server";
import { share, sharedArtifact } from "./shares";
import { artifact } from "./store";
test("temporary provider media share is scoped, opaque and expires", async () => {
	const root = await mkdtemp(join(tmpdir(), "director-share-test-")),
		oldRoot = process.env.OPENCUT_ACCOUNTS_DIR,
		oldOrigin = process.env.OPENCUT_PUBLIC_ORIGIN;
	try {
		process.env.OPENCUT_ACCOUNTS_DIR = root;
		process.env.OPENCUT_PUBLIC_ORIGIN = "https://opencut.test";
		await accountScope.run(
			{ id: "test-account", login: "test", displayName: "Test" },
			async () => {
				const ref = await artifact({
					root: join(root, "data/test-account/generative"),
					projectId: "project-a",
					name: "voice.mp3",
					mime: "audio/mpeg",
					bytes: Buffer.from("unchanged-original-audio"),
				});
				const url = await share({ projectId: "project-a", reference: ref });
				const token = new URL(url).pathname.split("/").at(-1)!;
				expect(token).toMatch(/^[a-f0-9]{64}$/);
				const result = await sharedArtifact(token);
				expect(await readFile(result.path, "utf8")).toBe(
					"unchanged-original-audio",
				);
				await expect(sharedArtifact("../other-account")).rejects.toThrow();
				const original = Date.now;
				try {
					const now = original();
					Date.now = () => now + 3601_000;
					await expect(sharedArtifact(token)).rejects.toThrow("expired");
				} finally {
					Date.now = original;
				}
			},
		);
	} finally {
		if (oldRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = oldRoot;
		if (oldOrigin === undefined) delete process.env.OPENCUT_PUBLIC_ORIGIN;
		else process.env.OPENCUT_PUBLIC_ORIGIN = oldOrigin;
		await rm(root, { recursive: true, force: true });
	}
});
