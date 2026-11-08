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
