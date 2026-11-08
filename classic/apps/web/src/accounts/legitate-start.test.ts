import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST } from "@/app/api/accounts/legitate/start/route";
import { GET as connect } from "@/app/api/accounts/legitate/connect/route";
import { registerAccount, sessionCookie } from "./server";

const root = await mkdtemp(join(tmpdir(), "opencut-legitate-start-"));
const previous = {
	root: process.env.OPENCUT_ACCOUNTS_DIR,
	client: process.env.OPENCUT_LEGITATE_CLIENT_ID,
	only: process.env.OPENCUT_LEGITATE_ONLY,
};
process.env.OPENCUT_ACCOUNTS_DIR = root;
process.env.OPENCUT_LEGITATE_CLIENT_ID = "opencut-local";
process.env.OPENCUT_LEGITATE_ONLY = "false";
afterAll(async () => {
	for (const [key, value] of Object.entries({
		OPENCUT_ACCOUNTS_DIR: previous.root,
		OPENCUT_LEGITATE_CLIENT_ID: previous.client,
		OPENCUT_LEGITATE_ONLY: previous.only,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(root, { recursive: true, force: true });
});
function request(cookie?: string) {
	return new Request("http://127.0.0.1:3000/api/accounts/legitate/start", {
		method: "POST",
		headers: {
			origin: "http://127.0.0.1:3000",
			"sec-fetch-site": "same-origin",
			...(cookie ? { cookie } : {}),
		},
	});
}
test("first link requires the local account in the same browser, while an existing binding permits Legitate-only sign-in", async () => {
	const unauthenticated = await POST(request());
	expect(unauthenticated.status).toBe(401);
	expect(unauthenticated.headers.get("location")).toBe(null);
	expect(unauthenticated.headers.get("set-cookie")).toBe(null);
	expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
	expect(await unauthenticated.text()).toContain(
		"Sign in to your OpenCut workspace first",
	);
	const session = await registerAccount({
		login: "legitate-fixture",
		displayName: "Fixture",
		password: "fixture-only-local-password",
	});
	const authenticated = await POST(
		request(sessionCookie(session.token).split(";")[0]),
	);
	const navigationHeaders = {
		cookie: sessionCookie(session.token).split(";")[0],
		"sec-fetch-site": "cross-site",
		"sec-fetch-mode": "navigate",
		"sec-fetch-dest": "document",
	};
	expect(
		(
			await connect(
				new Request("http://127.0.0.1:3000/api/accounts/legitate/connect", {
					headers: navigationHeaders,
				}),
			)
		).status,
	).toBe(200);
	expect(
		(
			await connect(
				new Request("http://127.0.0.1:3000/api/accounts/legitate/connect", {
					headers: { ...navigationHeaders, "sec-fetch-mode": "cors" },
				}),
			)
		).status,
	).toBe(401);
	expect(
		(
			await connect(
				new Request("http://127.0.0.1:3000/api/accounts/legitate/connect", {
					headers: {
						...navigationHeaders,
						origin: "https://untrusted.example",
					},
				}),
			)
		).status,
	).toBe(401);
	expect(
		(
			await POST(
				new Request("http://127.0.0.1:3000/api/accounts/legitate/start", {
					method: "POST",
					headers: {
						...navigationHeaders,
						origin: "https://untrusted.example",
					},
				}),
			)
		).status,
	).toBe(400);
	expect(authenticated.status).toBe(303);
	expect(new URL(authenticated.headers.get("location")!).origin).toBe(
		"https://auth.legitate.com",
	);
	expect(authenticated.headers.get("set-cookie")).toContain(
		"opencut-legitate=",
	);
	expect(authenticated.headers.get("set-cookie")).toContain("Max-Age=900");
	await writeFile(
		join(root, "legitate-primary.json"),
		JSON.stringify({ subjectHash: "a".repeat(64), account: session.account }),
	);
	const linkedSignIn = await POST(request());
	expect(linkedSignIn.status).toBe(303);
});
