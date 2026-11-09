import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "@/app/api/accounts/route";
import { registerAccount, newSession, sessionCookie } from "./server";
import { GET as legacyGet, POST as legacyPost } from "@/app/api/auth/[...all]/route";
mock.module("opencut-wasm", () => ({
	batchEditIsLocked: () => false,
	fullAutoEditStages: () => [],
	batchEditTransition: () => { throw new Error("Unexpected batch edit"); },
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
	mediaRelinkBinding: () => { throw new Error("Unexpected media relink"); },
	browserRecoveryProject: () => { throw new Error("Unexpected browser recovery"); },
}));
const { POST: drive } = await import("@/app/api/local-drive/route");
const root = await mkdtemp(join(tmpdir(), "opencut-legitate-only-"));
const originalRoot = process.env.OPENCUT_ACCOUNTS_DIR;
const originalOnly = process.env.OPENCUT_LEGITATE_ONLY;
process.env.OPENCUT_ACCOUNTS_DIR = root;
process.env.OPENCUT_LEGITATE_ONLY = "false";
afterAll(async () => {
	if (originalRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
	else process.env.OPENCUT_ACCOUNTS_DIR = originalRoot;
	if (originalOnly === undefined) delete process.env.OPENCUT_LEGITATE_ONLY;
	else process.env.OPENCUT_LEGITATE_ONLY = originalOnly;
	await rm(root, { recursive: true, force: true });
});
test("Legitate-only rejects password entry and old local sessions, accepts the linked provider session and permits logout", async () => {
	const local = await registerAccount({
		login: "fixture-only",
		displayName: "Fixture",
		password: "fixture-local-secret-only",
	});
	const provider = await newSession(local.account, "legitate");
	process.env.OPENCUT_LEGITATE_ONLY = "true";
	const headers = {
		origin: "http://127.0.0.1:3000",
		"sec-fetch-site": "same-origin",
		"content-type": "application/json",
	};
	for (const action of ["login", "register", "recover", "change-password"]) {
		const response = await POST(
			new Request("http://127.0.0.1:3000/api/accounts", {
				method: "POST",
				headers,
				body: JSON.stringify({
					action,
					login: "fixture-only",
					password: "fixture-local-secret-only",
				}),
			}),
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("set-cookie")).toBe(null);
	}
	const inspect = (token: string) =>
		GET(
			new Request("http://127.0.0.1:3000/api/accounts", {
				headers: { cookie: sessionCookie(token).split(";")[0] },
			}),
		).then((response) => response.json());
	expect((await inspect(local.token)).account).toBe(null);
	const authenticated = await inspect(provider.token);
	expect(authenticated.account.id).toBe(local.account.id);
	expect(authenticated.legitateOnly).toBe(true);
	const logout = await POST(
		new Request("http://127.0.0.1:3000/api/accounts", {
			method: "POST",
			headers: {
				...headers,
				cookie: sessionCookie(provider.token).split(";")[0],
			},
			body: JSON.stringify({ action: "logout" }),
		}),
	);
	expect(logout.status).toBe(200);
	expect((await inspect(provider.token)).account).toBe(null);
});

test("Legitate-only also blocks the legacy hosted password and session endpoints before hosted initialization", async () => {
	process.env.OPENCUT_LEGITATE_ONLY = "true";
	for (const endpoint of ["sign-in/email", "sign-up/email", "reset-password"]) {
		const response = await legacyPost(new Request(`http://127.0.0.1:3000/api/auth/${endpoint}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: "{}",
		}));
		expect(response.status).toBe(403);
		expect(response.headers.get("set-cookie")).toBe(null);
		expect(response.headers.get("cache-control")).toBe("no-store");
	}
	expect((await legacyGet(new Request("http://127.0.0.1:3000/api/auth/get-session"))).status).toBe(403);
});

test("hosted storage requires a Legitate session and rejects linking host files", async () => {
	const env = {
		OPENCUT_LEGITATE_HOSTED: "true",
		OPENCUT_LEGITATE_ONLY: "true",
		OPENCUT_PUBLIC_ORIGIN: "https://pocut.vxu.me",
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	try {
		const account = { id: crypto.randomUUID(), displayName: "Fixture", login: "hosted" };
		const { token } = await newSession(account, "legitate");
		const request = (operation: string, signedIn: boolean) => new Request(
			"https://pocut.vxu.me/api/local-drive",
			{
				method: "POST",
				headers: {
					host: "pocut.vxu.me",
					origin: env.OPENCUT_PUBLIC_ORIGIN,
					"sec-fetch-site": "same-origin",
					"content-type": "application/json",
					...(signedIn ? { cookie: sessionCookie(token).split(";")[0] } : {}),
				},
				body: JSON.stringify({ operation }),
			},
		);
		expect((await drive(request("preferences.list", false))).status).toBe(401);
		const result = await drive(request("preferences.list", true));
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({});
		expect((await drive(request("media.registerPath", true))).status).toBe(403);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
