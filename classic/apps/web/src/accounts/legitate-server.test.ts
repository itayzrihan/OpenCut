import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalFetch = globalThis.fetch;
let subject = "primary";
mock.module("./legitate-oidc", () => ({
	LEGITATE_ISSUER: "https://auth.legitate.com",
	createLegitateAuthorization: () => {
		const state = crypto.randomUUID();
		return {
			state,
			nonce: "nonce",
			verifier: "verifier",
			url: `https://auth.legitate.com/?state=${state}`,
		};
	},
	matchesLegitateState: (expected: string, actual: string) =>
		expected === actual,
	verifyLegitateIdToken: async () => ({
		issuer: "https://auth.legitate.com",
		subject,
	}),
}));
const { legitateStart, legitateFinish, LegitateSignInFailure } =
	await import("./legitate-server");
const root = await mkdtemp(join(tmpdir(), "opencut-legitate-test-"));
const previousRoot = process.env.OPENCUT_ACCOUNTS_DIR;
const previousClient = process.env.OPENCUT_LEGITATE_CLIENT_ID;
process.env.OPENCUT_ACCOUNTS_DIR = root;
process.env.OPENCUT_LEGITATE_CLIENT_ID = "opencut-local";
globalThis.fetch = (async () =>
	new Response(JSON.stringify({ id_token: "test" }), {
		status: 200,
	})) as unknown as typeof fetch;
afterAll(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
	else process.env.OPENCUT_ACCOUNTS_DIR = previousRoot;
	if (previousClient === undefined)
		delete process.env.OPENCUT_LEGITATE_CLIENT_ID;
	else process.env.OPENCUT_LEGITATE_CLIENT_ID = previousClient;
	await rm(root, { recursive: true, force: true });
});

test("reports the failing exchange stage without exposing provider responses or codes", async () => {
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({ error_description: "private-provider-detail" }),
			{ status: 400 },
		)) as unknown as typeof fetch;
	try {
		const tx = legitateStart("http://localhost:3000", null);
		let failure: unknown;
		try {
			await legitateFinish({
				state: new URL(tx.url).searchParams.get("state")!,
				browser: tx.browser,
				code: "private-authorization-code",
			});
		} catch (error) {
			failure = error;
		}
		expect(failure instanceof LegitateSignInFailure).toBe(true);
		if (!(failure instanceof LegitateSignInFailure))
			throw new Error("Missing safe sign-in failure");
		expect(failure.diagnostics).toEqual({
			stage: "token_exchange",
			httpStatus: 400,
		});
		expect(JSON.stringify(failure)).not.toContain("private-provider-detail");
		expect(JSON.stringify(failure)).not.toContain("private-authorization-code");
	} finally {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ id_token: "test" }), {
				status: 200,
			})) as unknown as typeof fetch;
	}
});

test("keeps token-validation diagnostics bounded and excludes raw exception data", () => {
	const error = Object.assign(new Error("private-identity-token"), {
		code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
		claim: "aud",
		payload: { sub: "private-subject" },
	});
	const failure = new LegitateSignInFailure({
		stage: "id_token_validation",
		error,
		httpStatus: 200,
	});
	expect(failure.diagnostics).toEqual({
		stage: "id_token_validation",
		code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
		claim: "aud",
		httpStatus: 200,
	});
	expect(JSON.stringify(failure)).not.toContain("private-");
	expect(failure.message).not.toContain("private-");
	const untrusted = new LegitateSignInFailure({
		stage: "workspace_binding",
		error: { code: "private-code", claim: "private-claim" },
	});
	expect(untrusted.diagnostics).toEqual({ stage: "workspace_binding" });
});
test("allows time for real MFA but rejects expired and reused transactions", async () => {
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	try {
		const account = {
			id: "11111111-1111-4111-8111-111111111111",
			login: "local",
			displayName: "Local",
		};
		const begin = () => {
			const tx = legitateStart("http://localhost:3000", account);
			return {
				state: new URL(tx.url).searchParams.get("state")!,
				browser: tx.browser,
				code: "fixture-code",
			};
		};
		const slowMfa = begin();
		now += 9 * 60_000;
		expect(await legitateFinish(slowMfa)).toEqual(account);
		await expect(legitateFinish(slowMfa)).rejects.toThrow(
			"Legitate sign-in expired",
		);
		const expired = begin();
		now += 16 * 60_000;
		await expect(legitateFinish(expired)).rejects.toThrow(
			"Legitate sign-in expired",
		);
	} finally {
		clock.mockRestore();
	}
});

test("requires browser-bound one-use transactions and keeps the first verified identity bound to its workspace", async () => {
	const account = {
		id: "11111111-1111-4111-8111-111111111111",
		login: "local",
		displayName: "Local",
	};
	const attempt = (accountToLink: typeof account | null = null) => {
		const tx = legitateStart("http://localhost:3000", accountToLink);
		return {
			state: new URL(tx.url).searchParams.get("state")!,
			browser: tx.browser,
			code: "code",
		};
	};
	const wrongBrowser = attempt(account);
	await expect(
		legitateFinish({ ...wrongBrowser, browser: "another browser" }),
	).rejects.toThrow();
	const first = attempt(account);
	expect(await legitateFinish(first)).toEqual(account);
	await expect(legitateFinish(first)).rejects.toThrow();
	expect(await legitateFinish(attempt())).toEqual(account);
	subject = "other-subject";
	await expect(legitateFinish(attempt())).rejects.toThrow();
	subject = "primary";
	await expect(
		legitateFinish(
			attempt({ ...account, id: "22222222-2222-4222-8222-222222222222" }),
		),
	).rejects.toThrow();
});

test("hosted Legitate sign-in allocates stable, separate workspaces by verified subject", async () => {
	const env = {
		OPENCUT_LEGITATE_HOSTED: "true",
		OPENCUT_LEGITATE_ONLY: "true",
		OPENCUT_PUBLIC_ORIGIN: "https://pocut.vxu.me",
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	const previousSubject = subject;
	Object.assign(process.env, env);
	try {
		async function signIn(as: string) {
			subject = as;
			const tx = legitateStart(env.OPENCUT_PUBLIC_ORIGIN, null);
			return legitateFinish({
				state: new URL(tx.url).searchParams.get("state")!,
				browser: tx.browser,
				code: "hosted-fixture",
			});
		}
		const first = await signIn("hosted-one");
		const second = await signIn("hosted-two");
		expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(second.id).not.toBe(first.id);
		expect(await signIn("hosted-one")).toEqual(first);
	} finally {
		subject = previousSubject;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("a hosted callback without identity consent explains the retry and issues no session", async () => {
	const { GET } = await import("@/app/api/accounts/legitate/callback/route");
	const env = {
		OPENCUT_LEGITATE_HOSTED: "true",
		OPENCUT_LEGITATE_ONLY: "true",
		OPENCUT_PUBLIC_ORIGIN: "https://pocut.vxu.me",
	};
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	const previousFetch = globalThis.fetch;
	Object.assign(process.env, env);
	try {
		const callback = () => {
			const tx = legitateStart(env.OPENCUT_PUBLIC_ORIGIN, null);
			const state = new URL(tx.url).searchParams.get("state")!;
			return GET(new Request(
				`${env.OPENCUT_PUBLIC_ORIGIN}/api/accounts/legitate/callback?state=${state}&code=fixture-code`,
				{ headers: { host: "pocut.vxu.me", cookie: `opencut-legitate=${tx.browser}` } },
			));
		};
		globalThis.fetch = (async () => Response.json({
			access_token: "private-fixture-access-token",
			scope: "",
		})) as unknown as typeof fetch;
		const denied = await callback();
		expect(denied.status).toBe(400);
		expect(denied.headers.get("set-cookie")).toBeNull();
		const html = await denied.text();
		expect(html).toContain("The account identification in the application");
		expect(html).toContain('href="/projects#sign-in"');
		expect(html).not.toContain("private-fixture-access-token");

		globalThis.fetch = (async () => Response.json({
			id_token: "verified-fixture-id-token",
			scope: "openid",
		})) as unknown as typeof fetch;
		const accepted = await callback();
		expect(accepted.status).toBe(303);
		expect(accepted.headers.get("location")).toBe(`${env.OPENCUT_PUBLIC_ORIGIN}/projects`);
		expect(accepted.headers.get("set-cookie")).toContain("opencut-account=");
	} finally {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
