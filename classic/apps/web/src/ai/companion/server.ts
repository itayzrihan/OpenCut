/** Loopback-only capability transport. No filesystem, shell or generic RPC routes. */
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { LocalProvider } from "./protocol";

const pairingSchema = z
	.object({
		version: z.literal(1),
		origin: z.string().url(),
		accountId: z.string().uuid(),
		token: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type Pairing = z.infer<typeof pairingSchema>;
export function validatePairing(value: unknown): Pairing {
	const pair = pairingSchema.parse(value);
	const url = new URL(pair.origin);
	if (
		url.origin !== pair.origin ||
		url.protocol !== "https:" ||
		url.username ||
		url.password
	)
		throw new Error("Pairing requires an exact HTTPS app origin");
	return pair;
}
export type CompanionHandler = (args: {
	path: string;
	method: string;
	body: Uint8Array;
	signal: AbortSignal;
	provider: LocalProvider;
}) => Promise<Response>;
const routes = new Map([
	["GET /api/editor-agent/connection", true],
	["POST /api/editor-agent/connection", true],
	["POST /api/editor-agent/respond", true],
	["GET /api/ai/oauth/status", true],
	["GET /api/ai/models", true],
	["POST /api/ai/chat", true],
	["POST /api/ai/local-image", true],
]);
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
	let active = 0;
	const server = createServer(async (req, res) => {
		const fail = ({ status, error }: { status: number; error: string }) => {
			res.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
			});
			res.end(JSON.stringify({ error }));
		};
		const address = server.address();
		const bound = typeof address === "object" && address ? address.port : port;
		if (req.headers.host !== `127.0.0.1:${bound}`)
			return fail({ status: 403, error: "Unexpected local host" });
		if (req.headers.origin !== pair.origin)
			return fail({ status: 403, error: "This app origin is not paired" });
		res.setHeader("Access-Control-Allow-Origin", pair.origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Private-Network", "true");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Authorization, Content-Type, X-OpenCut-Account, X-POCUT-Provider",
		);
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		if (req.method === "OPTIONS") {
			if (![...routes.keys()].some((key) => key.endsWith(" " + req.url)))
				return fail({ status: 404, error: "Unsupported local AI operation" });
			res.writeHead(204);
			return res.end();
		}
		const token = req.headers.authorization?.slice(7) ?? "";
		if (
			!req.headers.authorization?.startsWith("Bearer ") ||
			!/^[a-f0-9]{64}$/.test(token) ||
			!timingSafeEqual(Buffer.from(token), Buffer.from(pair.token)) ||
			req.headers["x-opencut-account"] !== pair.accountId
		)
			return fail({
				status: 401,
				error: "This POCUT account is not paired with this device",
			});
		if (!routes.has(`${req.method} ${req.url}`))
			return fail({ status: 404, error: "Unsupported local AI operation" });
		const provider = req.headers["x-pocut-provider"] ?? "codex";
		if (provider !== "codex" && provider !== "claude")
			return fail({ status: 400, error: "Unknown local provider" });
		if (active >= 2)
			return fail({ status: 429, error: "The local companion is busy" });
		active++;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 310_000);
		timeout.unref();
		res.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		try {
			const body = await readBody(req);
			const response = await handle({
				path: req.url!,
				method: req.method!,
				body,
				signal: controller.signal,
				provider,
			});
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
		} finally {
			clearTimeout(timeout);
			active--;
		}
	});
	return server;
}
async function readBody(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 12_000_000) throw new Error("Local AI request is too large");
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}
