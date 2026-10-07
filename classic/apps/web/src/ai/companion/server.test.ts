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
		handle: async (path) => {
			handled.push(path);
			return Response.json({
				authenticated: true,
				identity: { email: "alice@example.com" },
			});
		},
		port: 0,
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as { port: number }).port;
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
						host: "127.0.0.1:0",
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
