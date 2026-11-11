/** Loopback-only capability transport. No filesystem, shell or generic RPC routes. */
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
	CONTROL_PATH,
	SETUP_HEADER,
	SETUP_PATH,
	companionSetupSchema,
	pairingSchema,
	type CompanionSetup,
} from "./setup";
import type { LocalProvider } from "./protocol";

export type Pairing = ReturnType<typeof validatePairing>;
export function validatePairing(value: unknown) {
	return pairingSchema.parse(value);
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
type PairedConnection = { pair: Pairing; handle: CompanionHandler };
type SetupConnection = {
	request: CompanionSetup;
	activate: (pair: Pairing) => Promise<CompanionHandler>;
	restored?: PairedConnection;
};

export function createCompanionServer(
	options: ({ setup: SetupConnection } | PairedConnection) & {
		port?: number;
		control?: { token: string; stop: () => void };
	},
) {
	const setup = "setup" in options ? options.setup : undefined;
	let connection = "pair" in options ? options : setup?.restored;
	const origin = setup
		? companionSetupSchema.parse(setup.request).origin
		: validatePairing(connection?.pair).origin;
	if (connection && validatePairing(connection.pair).origin !== origin)
		throw new Error("The saved pairing belongs to a different workspace");
	if (options.control && !/^[a-f0-9]{64}$/.test(options.control.token))
		throw new Error("Invalid desktop control key.");
	const port = options.port ?? 43127;
	let activating = false;
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
		if (req.url === CONTROL_PATH && options.control) {
			const token = req.headers.authorization?.match(
				/^Bearer ([a-f0-9]{64})$/,
			)?.[1];
			if (
				req.headers.origin !== undefined ||
				!token ||
				!timingSafeEqual(Buffer.from(token), Buffer.from(options.control.token))
			)
				return fail({
					status: 403,
					error: "Local desktop authorization required",
				});
			if (req.method !== "GET" && req.method !== "POST")
				return fail({ status: 405, error: "Unsupported control method" });
			const { stop } = options.control;
			if (req.method === "POST") res.once("finish", stop);
			res.writeHead(204, { "Cache-Control": "no-store" }).end();
			return;
		}
		if (req.headers.origin !== origin)
			return fail({ status: 403, error: "This app origin is not paired" });
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
		res.setHeader("Access-Control-Allow-Private-Network", "true");
		res.setHeader(
			"Access-Control-Allow-Headers",
			`Authorization, Content-Type, X-OpenCut-Account, X-POCUT-Provider, ${SETUP_HEADER}`,
		);
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		const isSetup = setup && req.url === SETUP_PATH;
		if (req.method === "OPTIONS") {
			if (
				!isSetup &&
				![...routes.keys()].some((key) => key.endsWith(" " + req.url))
			)
				return fail({ status: 404, error: "Unsupported local AI operation" });
			res.writeHead(204);
			return res.end();
		}
		if (isSetup) {
			if (req.headers[SETUP_HEADER.toLowerCase()] !== setup.request.setupId)
				return fail({
					status: 403,
					error: "This pairing package does not match",
				});
			if (req.method === "GET") {
				if (!connection && Date.now() >= setup.request.expiresAt)
					return fail({
						status: 410,
						error: "Download fresh pairing instructions",
					});
				res.writeHead(200, {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				});
				return res.end(JSON.stringify({ setupId: setup.request.setupId }));
			}
			if (req.method !== "POST")
				return fail({ status: 405, error: "Unsupported setup method" });
			try {
				const body = await readBody({ req, maxBytes: 4096 });
				const pair = validatePairing(
					JSON.parse(Buffer.from(body).toString("utf8")),
				);
				if (pair.origin !== origin)
					return fail({ status: 403, error: "This app origin is not paired" });
				if (connection) {
					if (
						connection.pair.accountId !== pair.accountId ||
						!timingSafeEqual(
							Buffer.from(connection.pair.token),
							Buffer.from(pair.token),
						)
					)
						return fail({
							status: 409,
							error: "This installation is already paired",
						});
				} else {
					if (Date.now() >= setup.request.expiresAt)
						return fail({
							status: 410,
							error: "Download fresh pairing instructions",
						});
					if (activating)
						return fail({
							status: 409,
							error: "Pairing is in progress. Try again.",
						});
					activating = true;
					try {
						connection = { pair, handle: await setup.activate(pair) };
					} finally {
						activating = false;
					}
				}
				res.writeHead(204, { "Cache-Control": "no-store" });
				return res.end();
			} catch {
				return fail({ status: 400, error: "Could not complete local pairing" });
			}
		}
		const paired = connection;
		const token = req.headers.authorization?.slice(7) ?? "";
		if (
			!paired ||
			!req.headers.authorization?.startsWith("Bearer ") ||
			!/^[a-f0-9]{64}$/.test(token) ||
			!timingSafeEqual(Buffer.from(token), Buffer.from(paired.pair.token)) ||
			req.headers["x-opencut-account"] !== paired.pair.accountId
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
			const body = await readBody({ req });
			const response = await paired.handle({
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
async function readBody({
	req,
	maxBytes = 12_000_000,
}: {
	req: IncomingMessage;
	maxBytes?: number;
}) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new Error("Local AI request is too large");
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}
