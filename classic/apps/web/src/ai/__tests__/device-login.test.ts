import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { accountScope } from "@/accounts/server";
import type { DeviceLoginProcess } from "../server/device-login-process";

const directory = mkdtempSync(join(tmpdir(), "opencut-device-login-tests-"));
process.env.OPENCUT_OPENAI_OAUTH_SESSION_DIR = directory;
process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET =
	"device-login-test-key-never-used-in-production";
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const { handleDeviceLogin, cancelDeviceLogin } =
	await import("../server/device-login");
const {
	getOpenAIOAuthStatus,
	clearOpenAICredentials,
	setCredentialsCookie,
	getSessionBinding,
	testing,
} = await import("../server/openai-codex-oauth");
const { handleAiChatRequest } = await import("../server/chat-handler");
const alice = { id: "alice-device", login: "alice", displayName: "Alice" };
const bob = { id: "bob-device", login: "bob", displayName: "Bob" };
function request(
	account: string,
	session: string,
	action: string,
	cookies = "",
) {
	return new NextRequest("http://localhost:3000/api/ai/oauth/device", {
		method: "POST",
		headers: {
			origin: "http://localhost:3000",
			"X-OpenCut-Account": account,
			cookie: `opencut-account=${session}; ${cookies}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ action }),
	});
}
function cookies(response: NextResponse) {
	return response.cookies
		.getAll()
		.filter((c) => c.value)
		.map((c) => `${c.name}=${c.value}`)
		.join("; ");
}
function tokens(label: string) {
	return {
		access_token: `header.${Buffer.from(
			JSON.stringify({
				exp: Date.now() / 1000 + 3600,
				"https://api.openai.com/auth": { chatgpt_account_id: label },
				"https://api.openai.com/profile": { email: `${label}@example.test` },
			}),
		).toString("base64url")}.signature`,
		refresh_token: `secret-refresh-${label}`,
	};
}
function fakeProcess() {
	let complete!: (tokens: Record<string, unknown>) => void;
	let closed = false;
	const process: DeviceLoginProcess = {
		start: Promise.resolve({
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "TEST-1234",
		}),
		completed: new Promise((resolve) => {
			complete = resolve;
		}),
		close: async () => {
			closed = true;
		},
	};
	return { process, complete, isClosed: () => closed };
}

test("device login is bound to account + browser session; encrypted credentials never appear in responses", async () => {
	const a = fakeProcess();
	const start = await accountScope.run(alice, () =>
		handleDeviceLogin(
			request(alice.id, "session-a", "start"),
			async () => a.process,
		),
	);
	expect(start.status).toBe(200);
	const binding = cookies(start);
	expect((await start.json()).userCode).toBe("TEST-1234");
	const stolen = request(bob.id, "session-b", "poll", binding);
	expect(
		(await accountScope.run(bob, () => handleDeviceLogin(stolen))).status,
	).toBe(410);
	await accountScope.run(bob, () => cancelDeviceLogin(stolen));
	expect(a.isClosed()).toBe(false);
	const rotated = request(alice.id, "session-a-new", "poll", binding);
	expect(
		(await accountScope.run(alice, () => handleDeviceLogin(rotated))).status,
	).toBe(410);
	const poll = request(alice.id, "session-a", "poll", binding);
	expect(
		await (
			await accountScope.run(alice, () =>
				handleDeviceLogin(new NextRequest(poll.clone())),
			)
		).json(),
	).toEqual({ pending: true });
	a.complete(tokens("openai-alice"));
	await Promise.resolve();
	const finished = await accountScope.run(alice, () =>
		handleDeviceLogin(new NextRequest(poll.clone())),
	);
	expect(await finished.clone().json()).toEqual({ authenticated: true });
	expect(JSON.stringify([...finished.headers])).not.toContain("secret-refresh");
	const authCookies = `${binding}; ${cookies(finished)}`;
	for (const file of readdirSync(directory))
		expect(readFileSync(join(directory, file), "utf8")).not.toContain(
			"secret-refresh",
		);
	const auth = request(alice.id, "session-a", "poll", authCookies);
	testing.resetOAuthRuntimeForTests();
	const identity = await accountScope.run(alice, () =>
		getOpenAIOAuthStatus({ request: auth }),
	);
	expect(identity.status.identity?.accountId).toBe("openai-alice");
	expect(
		(await accountScope.run(bob, () => getOpenAIOAuthStatus({ request: auth })))
			.status.authenticated,
	).toBe(false);
	const originalFetch = globalThis.fetch;
	const upstream: string[] = [];
	globalThis.fetch = (async (_url, init) => {
		upstream.push(new Headers(init?.headers).get("Authorization")!);
		return Response.json({ id: "synthetic-response", output_text: "Verified" });
	}) as typeof fetch;
	const chat = () =>
		new NextRequest("http://localhost:3000/api/ai/chat", {
			method: "POST",
			headers: {
				cookie: auth.headers.get("cookie")!,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: [{ role: "user", content: "Test isolation" }],
			}),
		});
	try {
		expect(
			(await accountScope.run(bob, () => handleAiChatRequest(chat()))).status,
		).toBe(401);
		expect(upstream).toHaveLength(0);
		expect(
			(await accountScope.run(alice, () => handleAiChatRequest(chat()))).status,
		).toBe(200);
		expect(upstream).toEqual([`Bearer ${identity.credentials!.access}`]);
	} finally {
		globalThis.fetch = originalFetch;
	}
	expect(
		(await accountScope.run(alice, () => handleDeviceLogin(poll))).status,
	).toBe(410);
	accountScope.run(alice, () =>
		clearOpenAICredentials({ request: auth, response: NextResponse.json({}) }),
	);
	expect(
		(
			await accountScope.run(alice, () =>
				getOpenAIOAuthStatus({ request: auth }),
			)
		).status.authenticated,
	).toBe(false);
});

test("concurrent refresh uses one token exchange and logout cannot be undone by its response", async () => {
	const base = request(
		alice.id,
		"refresh-session",
		"poll",
		"opencut_openai_oauth_binding=refresh-binding",
	);
	const credentials = {
		access: "expired",
		refresh: "private-refresh",
		expires: Date.now() - 1,
		sessionBinding: accountScope.run(alice, () =>
			getSessionBinding({ request: base }),
		),
	};
	const saved = NextResponse.json({});
	setCredentialsCookie({ response: saved, credentials });
	const req = request(
		alice.id,
		"refresh-session",
		"poll",
		`opencut_openai_oauth_binding=refresh-binding; ${cookies(saved)}`,
	);
	const originalFetch = globalThis.fetch;
	let resolve!: (r: Response) => void;
	let calls = 0;
	globalThis.fetch = (() => {
		calls++;
		return new Promise<Response>((yes) => {
			resolve = yes;
		});
	}) as typeof fetch;
	try {
		const one = accountScope.run(alice, () =>
			getOpenAIOAuthStatus({ request: req }),
		);
		const two = accountScope.run(alice, () =>
			getOpenAIOAuthStatus({ request: req }),
		);
		expect(calls).toBe(1);
		accountScope.run(alice, () =>
			clearOpenAICredentials({ request: req, response: NextResponse.json({}) }),
		);
		resolve(Response.json({ ...tokens("revoked"), expires_in: 3600 }));
		expect((await one).status.authenticated).toBe(false);
		expect((await two).status.authenticated).toBe(false);
		testing.resetOAuthRuntimeForTests();
		expect(
			(
				await accountScope.run(alice, () =>
					getOpenAIOAuthStatus({ request: req }),
				)
			).status.authenticated,
		).toBe(false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("cancelled login cannot later recreate a credential session; another account is unaffected", async () => {
	const a = fakeProcess(),
		b = fakeProcess();
	const startA = await accountScope.run(alice, () =>
		handleDeviceLogin(
			request(alice.id, "cancel-a", "start"),
			async () => a.process,
		),
	);
	const startB = await accountScope.run(bob, () =>
		handleDeviceLogin(
			request(bob.id, "cancel-b", "start"),
			async () => b.process,
		),
	);
	const reqA = request(alice.id, "cancel-a", "cancel");
	await accountScope.run(alice, () => handleDeviceLogin(reqA));
	expect(a.isClosed()).toBe(true);
	expect(b.isClosed()).toBe(false);
	a.complete(tokens("cancelled"));
	b.complete(tokens("openai-bob"));
	await Promise.resolve();
	expect(
		(
			await accountScope.run(alice, () =>
				handleDeviceLogin(
					request(alice.id, "cancel-a", "poll", cookies(startA)),
				),
			)
		).status,
	).toBe(410);
	const doneB = await accountScope.run(bob, () =>
		handleDeviceLogin(request(bob.id, "cancel-b", "poll", cookies(startB))),
	);
	expect((await doneB.json()).authenticated).toBe(true);
});

test("missing/mismatched account header and oversized or invalid actions never start a process", async () => {
	let called = false;
	const factory = async () => {
		called = true;
		return fakeProcess().process;
	};
	for (const req of [
		request(bob.id, "a", "start"),
		request(alice.id, "a", "unknown"),
		request(alice.id, "a", "x".repeat(1100)),
	]) {
		const response = await accountScope.run(alice, () =>
			handleDeviceLogin(req, factory),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
	}
	expect(called).toBe(false);
});
