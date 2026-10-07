/** Loopback-only client transport. No editor, filesystem, shell or MCP routes. */
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface Pairing {
	version: 1;
	origin: string;
	accountId: string;
	token: string;
}
export function validatePairing(value: unknown): Pairing {
	const p = value as Pairing;
	if (
		p?.version !== 1 ||
		!/^[a-f0-9-]{36}$/.test(p.accountId) ||
		!/^[a-f0-9]{64}$/.test(p.token)
	)
		throw Error("Invalid device pairing file");
	const url = new URL(p.origin);
	if (
		url.origin !== p.origin ||
		url.protocol !== "https:" ||
		url.username ||
		url.password
	)
		throw Error("Pairing requires an exact HTTPS app origin");
	return p;
}
export type CompanionHandler = (
	path: string,
	method: string,
	body: Uint8Array,
	signal: AbortSignal,
) => Promise<Response>;
export function createCompanionServer({
	pair,
	handle,
	port = 43127,
}: {
	pair: Pairing;
	handle: CompanionHandler;
	port?: number;
}) {
	validatePairing(pair);
	return createServer(async (req, res) => {
		const fail = ({ status, error }: { status: number; error: string }) => {
			res.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			});
			res.end(JSON.stringify({ error }));
		};
		if (req.headers.host !== `127.0.0.1:${port}`)
			return fail({ status: 403, error: "Unexpected local host" });
		if (req.method === "GET" && req.url?.startsWith("/?ai_oauth=error")) {
			res.writeHead(400, {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
				"Cache-Control": "no-store",
			});
			return res.end(
				"<!doctype html><title>OpenCut AI</title><h1>OpenAI sign-in did not complete</h1><p>Return to OpenCut and select Connect this device to try again.</p>",
			);
		}
		const callback =
			req.method === "GET" &&
			/^\/api\/ai\/oauth\/complete\?handoff=[a-f0-9-]{36}$/.test(req.url || "");
		if (!callback) {
			if (req.headers.origin !== pair.origin)
				return fail({ status: 403, error: "This app origin is not paired" });
			res.setHeader("Access-Control-Allow-Origin", pair.origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Private-Network", "true");
			res.setHeader(
				"Access-Control-Allow-Headers",
				"Authorization, Content-Type, X-OpenCut-Account",
			);
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
			if (req.method === "OPTIONS") {
				res.writeHead(204);
				return res.end();
			}
			const token = req.headers.authorization?.slice(7) || "";
			if (
				!req.headers.authorization?.startsWith("Bearer ") ||
				!/^[a-f0-9]{64}$/.test(token) ||
				!timingSafeEqual(Buffer.from(token), Buffer.from(pair.token)) ||
				req.headers["x-opencut-account"] !== pair.accountId
			)
				return fail({
					status: 401,
					error: "This OpenCut account is not paired with this device",
				});
			const allowed =
				req.method === "GET"
					? ["/api/ai/oauth/status", "/api/ai/models"]
					: req.method === "POST"
						? ["/api/ai/oauth/start", "/api/ai/oauth/logout", "/api/ai/chat"]
						: [];
			if (!allowed.includes(req.url || ""))
				return fail({ status: 404, error: "Unsupported local AI operation" });
		}
		const controller = new AbortController();
		res.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		try {
			const body = await readBody(req);
			const response = await handle(
				req.url!,
				req.method!,
				body,
				controller.signal,
			);
			res.statusCode = response.status;
			for (const [name, value] of response.headers)
				if (!["set-cookie", "access-control-allow-origin"].includes(name))
					res.setHeader(name, value);
			res.setHeader("Cache-Control", "no-store");
			res.setHeader("X-Content-Type-Options", "nosniff");
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			if (!res.headersSent)
				fail({
					status: 400,
					error:
						error instanceof Error ? error.message : "Local AI request failed",
				});
		}
	});
}
async function readBody(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1_000_000) throw Error("AI request is too large");
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}
