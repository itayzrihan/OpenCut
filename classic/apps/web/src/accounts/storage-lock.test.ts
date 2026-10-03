import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	registerAccount,
	markAccountImport,
	withAccount,
	sessionCookie,
} from "./server";

test("background snapshots permit editor saves while restore locks reject them", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-storage-lock-")),
		previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	let id: string | undefined;
	try {
		const identity = await registerAccount(
			"lock-owner",
			"Lock Owner",
			"storage lock test password",
		);
		id = identity.account.id;
		const request = () =>
			new Request("http://localhost:3000/api/local-drive", {
				method: "POST",
				headers: {
					origin: "http://localhost:3000",
					cookie: sessionCookie(identity.token),
				},
			});
		const save = withAccount(async () => Response.json({ saved: true }));
		await markAccountImport(id, true, "snapshot");
		expect((await save(request())).status).toBe(200);
		await expect(markAccountImport(id, true)).rejects.toThrow(
			"already running",
		);
		await markAccountImport(id, false);
		await markAccountImport(id, true, "exclusive");
		expect((await save(request())).status).toBe(423);
		await markAccountImport(id, false);
		expect((await save(request())).status).toBe(200);
	} finally {
		if (id) await markAccountImport(id, false);
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
