import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountScope,
	authenticateAccount,
	logoutAccount,
	registerAccount,
	sessionCookie,
	type LocalAccount,
} from "@/accounts/server";
import { onAccountDisconnect } from "@/accounts/lifecycle";
import {
	DEFAULT_PEER_RELAY_URL,
	cachePeerIdentity,
	peerIdentityProof,
	peerDeviceIdentity,
	configuredRelayUrl,
} from "./identity";

test("host credentials and concurrent device registration stay scoped to the linked account", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-peer-identity-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	const alice = {
		id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
		login: "alice",
		displayName: "Alice",
	} as LocalAccount;
	const bob = {
		...alice,
		id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
		login: "bob",
	};
	try {
		await mkdir(root, { recursive: true });
		await writeFile(
			join(root, "legitate-primary.json"),
			JSON.stringify({ account: alice, subjectHash: "a".repeat(64) }),
		);
		await cachePeerIdentity({
			accountId: alice.id,
			subjectHash: "a".repeat(64),
			idToken: "verified-by-login-fixture",
		});
		await cachePeerIdentity({
			accountId: bob.id,
			subjectHash: "b".repeat(64),
			idToken: "other-account-proof",
		});
		await accountScope.run(alice, async () => {
			expect((await peerIdentityProof()).owner).toBe("a".repeat(64));
			const devices = await Promise.all(
				Array.from({ length: 10 }, () => peerDeviceIdentity()),
			);
			expect(new Set(devices.map((device) => device.id)).size).toBe(1);
			expect(
				devices.every((device) => device.privateKey === devices[0].privateKey),
			).toBe(true);
		});
		await accountScope.run(bob, async () => {
			await expect(peerIdentityProof()).rejects.toThrow(
				"Sign in through Legitate",
			);
			const device = await peerDeviceIdentity();
			const other = JSON.parse(
				await readFile(
					join(root, "peer-devices", alice.id, "identity.json"),
					"utf8",
				),
			);
			expect(device.id).not.toBe(other.id);
			expect(device.privateKey).not.toBe(other.privateKey);
		});
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test("authenticated logout immediately notifies host services for that account", async () => {
	const root = await mkdtemp(join(tmpdir(), "opencut-peer-logout-"));
	const previous = process.env.OPENCUT_ACCOUNTS_DIR,
		previousMode = process.env.OPENCUT_LEGITATE_ONLY;
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	delete process.env.OPENCUT_LEGITATE_ONLY;
	const stopped: string[] = [];
	const remove = onAccountDisconnect({
		name: "peer-sync-logout-test",
		listener: (id) => {
			stopped.push(id);
		},
	});
	try {
		const session = await registerAccount({
			login: "logout-test",
			displayName: "Logout",
			password: "a long disposable test password",
		});
		const request = new Request("http://localhost:3000/api/accounts", {
			headers: { cookie: sessionCookie(session.token) },
		});
		await logoutAccount(request);
		expect(stopped).toEqual([session.account.id]);
		await expect(authenticateAccount(request)).rejects.toThrow();
	} finally {
		remove();
		if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
		else process.env.OPENCUT_ACCOUNTS_DIR = previous;
		if (previousMode === undefined) delete process.env.OPENCUT_LEGITATE_ONLY;
		else process.env.OPENCUT_LEGITATE_ONLY = previousMode;
		await rm(root, { recursive: true, force: true });
	}
});

test("remote relay URLs require TLS and reject embedded credentials and paths", () => {
	const previous = process.env.OPENCUT_SYNC_RELAY_URL;
	try {
		delete process.env.OPENCUT_SYNC_RELAY_URL;
		expect(configuredRelayUrl()).toBe(DEFAULT_PEER_RELAY_URL);
		process.env.OPENCUT_SYNC_RELAY_URL = "";
		expect(configuredRelayUrl()).toBeNull();
		for (const value of [
			"http://example.com",
			"https://user:secret@example.com",
			"https://example.com/path",
			"https://example.com/?token=secret",
		]) {
			process.env.OPENCUT_SYNC_RELAY_URL = value;
			expect(() => configuredRelayUrl()).toThrow();
		}
		process.env.OPENCUT_SYNC_RELAY_URL = "https://relay.example.com";
		expect(configuredRelayUrl()).toBe("https://relay.example.com");
		process.env.OPENCUT_SYNC_RELAY_URL = "http://127.0.0.1:4321";
		expect(configuredRelayUrl()).toBe("http://127.0.0.1:4321");
	} finally {
		if (previous === undefined) delete process.env.OPENCUT_SYNC_RELAY_URL;
		else process.env.OPENCUT_SYNC_RELAY_URL = previous;
	}
});
