import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	authenticateAccount,
	newSession,
	registerAccount,
	sessionCookie,
} from "./server";

test("Legitate-only mode rejects old password sessions but accepts a Legitate session", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-legitate-session-"));
	const oldRoot = process.env.OPENCUT_ACCOUNTS_DIR,
		oldMode = process.env.OPENCUT_LEGITATE_ONLY;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	delete process.env.OPENCUT_LEGITATE_ONLY;
	try {
		const local = await registerAccount({
			login: "local-account",
			displayName: "Local",
			password: "a long test password",
		});
		const request = (token: string) =>
			new Request("http://localhost:3000/api/accounts", {
				headers: { cookie: sessionCookie(token) },
			});
		expect((await authenticateAccount(request(local.token))).id).toBe(
			local.account.id,
		);
		const legitate = await newSession(local.account, "legitate");
		process.env.OPENCUT_LEGITATE_ONLY = "true";
		await expect(authenticateAccount(request(local.token))).rejects.toThrow();
		expect((await authenticateAccount(request(legitate.token))).id).toBe(
			local.account.id,
		);
	} finally {
		if (oldRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = oldRoot;
		if (oldMode === undefined) delete process.env.OPENCUT_LEGITATE_ONLY;
		else process.env.OPENCUT_LEGITATE_ONLY = oldMode;
		await rm(root, { recursive: true, force: true });
	}
});
