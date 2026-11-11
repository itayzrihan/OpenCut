import { test, expect } from "bun:test";
import { request } from "node:http";
import { once } from "node:events";
import { createCompanionServer, validatePairing } from "./server";

test("local AI binds every request to the paired origin, account and capability", async () => {
	const pair = {
		version: 1 as const,
		origin: "https://editor.example.com",
		accountId: "11111111-1111-4111-8111-111111111111",
		token: "a".repeat(64),
	};
	const handled: string[] = [];
	const server = createCompanionServer({
		pair: pair,
		handle: async ({ path }) => {
			handled.push(path);
			return Response.json({
				authenticated: true,
				identity: { email: "alice@example.com" },
			});
		},
		port: 0,
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No TCP listener");
	const { port } = address;
	const call = ({
		path,
		headers = {},
		method = "GET",
	}: {
		path: string;
		headers?: Record<string, string>;
		method?: string;
	}) =>
		new Promise<{
			status: number;
			body: string;
			headers: Record<string, unknown>;
		}>((resolve, reject) => {
			const r = request(
				{
					host: "127.0.0.1",
					port,
					path,
					method,
					headers: {
						host: `127.0.0.1:${port}`,
						origin: pair.origin,
						authorization: `Bearer ${pair.token}`,
						"X-OpenCut-Account": pair.accountId,
						...headers,
					},
				},
				(res) => {
					let body = "";
					res.on("data", (b) => {
						body += b;
					});
					res.on("end", () =>
						resolve({ status: res.statusCode!, body, headers: res.headers }),
					);
				},
			);
			r.on("error", reject);
			r.end();
		});
	try {
		expect((await call({ path: "/api/ai/oauth/status" })).status).toBe(200);
		expect(
			(await call({ path: "/api/ai/chat", headers: {}, method: "POST" }))
				.status,
		).toBe(200);
		const rejectedHeaders: Record<string, string>[] = [
			{ origin: "https://other.example.com" },
			{ origin: "" },
			{ host: "evil.example:0" },
			{ authorization: `Bearer ${"b".repeat(64)}` },
			{ authorization: `Bearer ${"é".repeat(64)}` },
			{ "X-OpenCut-Account": "22222222-2222-4222-8222-222222222222" },
		];
		for (const headers of rejectedHeaders) {
			const r = await call({ path: "/api/ai/oauth/status", headers: headers });
			expect([401, 403]).toContain(r.status);
			expect(r.body).not.toContain("alice@example.com");
		}
		for (const path of [
			"/api/local-drive",
			"/api/mcp-bridge/status",
			"/api/ai/oauth/status?account=other",
			"/api/ai/chat/../oauth/start",
		])
			expect((await call({ path: path })).status).toBe(404);
		expect((await call({ path: "/api/ai/oauth/logout" })).status).toBe(404);
		const preflight = await call({
			path: "/api/ai/chat",
			headers: {},
			method: "OPTIONS",
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers["access-control-allow-origin"]).toBe(pair.origin);
		expect(handled).toEqual(["/api/ai/oauth/status", "/api/ai/chat"]);
		expect(() =>
			validatePairing({ ...pair, origin: "http://editor.example.com" }),
		).toThrow();
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

test("setup authorizes one matching tab, with safe replay and expiry", async () => {
	const origin = "https://editor.example.com";
	const setupId = crypto.randomUUID();
	const pair = {
		version: 1 as const,
		origin,
		accountId: "11111111-1111-4111-8111-111111111111",
		token: "c".repeat(64),
	};
	const { SETUP_PATH, SETUP_HEADER } = await import("./setup");
	for (const expired of [false, true]) {
		let activationCount = 0;
		const server = createCompanionServer({
			setup: {
				request: {
					version: 1,
					setupId,
					origin,
					expiresAt: Date.now() + (expired ? -1000 : 60_000),
				},
				activate: async (candidate) => {
					expect(candidate).toEqual(pair);
					activationCount++;
					return async ({ provider }) => Response.json({ provider });
				},
			},
		}).listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No TCP listener");
		const { port } = address;
		const base = `http://127.0.0.1:${port}`;
		const headers = { Origin: origin, [SETUP_HEADER]: setupId };
		const post = (candidate = pair) =>
			fetch(base + SETUP_PATH, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(candidate),
			});
		const callProvider = (provider: "codex" | "claude") =>
			fetch(base + "/api/editor-agent/connection", {
				headers: {
					Origin: origin,
					Authorization: `Bearer ${pair.token}`,
					"X-OpenCut-Account": pair.accountId,
					"X-POCUT-Provider": provider,
				},
			});
		try {
			expect((await callProvider("codex")).status).toBe(401);
			expect(
				(
					await fetch(base + SETUP_PATH, {
						headers: { ...headers, Origin: "https://other.example.com" },
					})
				).status,
			).toBe(403);
			expect(
				(await fetch(base + SETUP_PATH, { headers: { Origin: origin } }))
					.status,
			).toBe(403);
			const preflight = await fetch(base + SETUP_PATH, {
				method: "OPTIONS",
				headers,
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain(
				SETUP_HEADER,
			);
			const ready = await fetch(base + SETUP_PATH, { headers });
			if (expired) {
				expect(ready.status).toBe(410);
				expect((await post()).status).toBe(410);
				expect(activationCount).toBe(0);
				continue;
			}
			expect(await ready.json()).toEqual({ setupId });
			expect(
				(await post({ ...pair, origin: "https://other.example.com" })).status,
			).toBe(403);
			expect((await post()).status).toBe(204);
			expect((await post()).status).toBe(204);
			expect((await post({ ...pair, token: "d".repeat(64) })).status).toBe(409);
			expect(
				(await post({ ...pair, accountId: crypto.randomUUID() })).status,
			).toBe(409);
			expect(await (await callProvider("codex")).json()).toEqual({
				provider: "codex",
			});
			expect(await (await callProvider("claude")).json()).toEqual({
				provider: "claude",
			});
			expect(activationCount).toBe(1);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
});

test("desktop lifecycle uses a private local key outside the app's browser API", async () => {
	const origin = "https://editor.example.com";
	const pair = {
		version: 1 as const,
		origin,
		accountId: crypto.randomUUID(),
		token: "a".repeat(64),
	};
	const control = "b".repeat(64);
	let stopped = 0;
	const server = createCompanionServer({
		pair,
		handle: async () => Response.json({ sharing: true }),
		control: {
			token: control,
			stop: () => {
				stopped++;
			},
		},
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No TCP listener");
	const { CONTROL_PATH } = await import("./setup");
	const url = `http://127.0.0.1:${address.port}${CONTROL_PATH}`;
	const auth = { Authorization: `Bearer ${control}` };
	try {
		expect(
			(
				await fetch(url, {
					method: "POST",
					headers: { ...auth, Origin: origin },
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(url, {
					method: "POST",
					headers: { Authorization: `Bearer ${pair.token}` },
				})
			).status,
		).toBe(403);
		expect(
			(await fetch(url, { method: "OPTIONS", headers: auth })).status,
		).toBe(405);
		expect((await fetch(url, { headers: auth })).status).toBe(204);
		expect(stopped).toBe(0);
		expect((await fetch(url, { method: "POST", headers: auth })).status).toBe(
			204,
		);
		expect(stopped).toBe(1);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});
