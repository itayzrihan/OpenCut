import { test, expect, mock } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountScope,
	authenticateAccount,
	registerAccount,
	loginAccount,
	logoutAccount,
	sessionCookie,
	assertLocalOrigin,
	localRequestOrigin,
	changeAccountPassword,
} from "./server";
import { assertAccountMediaSource } from "./media-source";
mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
}));

test("browser origin survives normalized Next URLs without accepting outside hosts", () => {
	const request = new Request("http://localhost:3100/api/ai/oauth/start", {
		headers: {
			host: "127.0.0.1:3100",
			origin: "http://127.0.0.1:3100",
			"sec-fetch-site": "same-origin",
		},
	});
	expect(localRequestOrigin(request)).toBe("http://127.0.0.1:3100");
	expect(() => assertLocalOrigin(request)).not.toThrow();
	for (const host of [
		"evil.example:3100",
		"127.0.0.1:3100@evil.example:3100",
		"evil@127.0.0.1:3100",
	]) {
		expect(() =>
			localRequestOrigin(new Request(request.url, { headers: { host } })),
		).toThrow();
	}
	expect(() =>
		assertLocalOrigin(
			new Request(request.url, {
				headers: { host: "127.0.0.1:3100", origin: "http://localhost:3100" },
			}),
		),
	).toThrow("Cross-origin");
});

test("authenticated accounts isolate projects, preferences and asset bytes under concurrent requests", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-accounts-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	try {
		const store = await import("@/services/local-drive/server");
		const alice = await registerAccount({ login: "alice", displayName: "Alice", password: "a secure password for Alice" }
		);
		const bob = await registerAccount({ login: "bob", displayName: "Bob", password: "a secure password for Bob" }
		);
		const privateMedia = join(root, "data", alice.account.id, "private.wav");
		await mkdir(join(root, "data", alice.account.id), { recursive: true });
		await writeFile(privateMedia, "alice private audio");
		await expect(
			accountScope.run(bob.account, () =>
				assertAccountMediaSource(privateMedia),
			),
		).rejects.toThrow("another account");
		expect(
			await accountScope.run(alice.account, () =>
				assertAccountMediaSource(privateMedia),
			),
		).toBe(privateMedia);
		const request = (token: string) =>
			new Request("http://localhost:3000/api/local-drive", {
				headers: {
					cookie: sessionCookie(token),
					origin: "http://localhost:3000",
				},
			});
		expect((await authenticateAccount(request(alice.token))).id).toBe(
			alice.account.id,
		);
		await expect(loginAccount({ login: "alice", password: "wrong password" })).rejects.toThrow(
			"Invalid credentials",
		);
		expect(
			(await loginAccount({ login: "ALICE", password: "a secure password for Alice" })).account.id,
		).toBe(alice.account.id);
		await Promise.all(
			[alice, bob].map(({ account }) =>
				accountScope.run(account, async () => {
					await store.putProject("same-project-id", {
						metadata: { id: "same-project-id", name: account.displayName },
						scenes: [],
					});
					await store.putPreference("panel-sizes", account.displayName);
					await store.storeSharedFile({
						kind: "audio",
						id: "same-file-id",
						body: new Blob([account.displayName]).stream(),
					});
					await new Promise((resolve) => setTimeout(resolve, 10));
					expect(await store.listPreferences()).toEqual({
						"panel-sizes": account.displayName,
					});
					expect(await store.getProject("same-project-id")).toMatchObject({
						metadata: { name: account.displayName },
					});
					const file = await store.getSharedFile("audio", "same-file-id");
					expect(await Bun.file(file!.path).text()).toBe(account.displayName);
				}),
			),
		);
		await accountScope.run(alice.account, () => store.clearAllDriveData());
		expect(
			await accountScope.run(bob.account, () => store.listProjects()),
		).toHaveLength(1);
		await expect(store.listProjects()).rejects.toThrow("Sign in");
		await logoutAccount(request(alice.token));
		await expect(authenticateAccount(request(alice.token))).rejects.toThrow();
		expect((await authenticateAccount(request(bob.token))).id).toBe(
			bob.account.id,
		);
		const changed = await accountScope.run(bob.account, () =>
			changeAccountPassword({ currentPassword: "a secure password for Bob", password: "a new secure password for Bob" }
			),
		);
		await expect(
			loginAccount({ login: "bob", password: "a secure password for Bob" }),
		).rejects.toThrow("Invalid credentials");
		await expect(authenticateAccount(request(bob.token))).rejects.toThrow();
		expect((await authenticateAccount(request(changed.token))).id).toBe(
			bob.account.id,
		);
		for (const origin of ["https://evil.test", "http://localhost:3001"]) {
			expect(() =>
				assertLocalOrigin(
					new Request("http://localhost:3000/api/accounts", {
						headers: { origin },
					}),
				),
			).toThrow();
		}
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
