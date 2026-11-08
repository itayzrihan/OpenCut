import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET, POST } from "@/app/api/accounts/route";
import { registerAccount, newSession, sessionCookie } from "./server";
import { GET as legacyGet, POST as legacyPost } from "@/app/api/auth/[...all]/route";
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
