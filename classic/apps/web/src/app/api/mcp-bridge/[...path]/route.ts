import {
	bridgeStatusSchema,
	fetchBridge,
	invalidateBridgeConfigs,
	isLoopbackHostname,
	loadBridgeConfigs,
	type BridgeConfig,
} from "@/mcp/server/classic-bridge";
import { legacyBridgeBody } from "@/accounts/bridge-protocol";
import { withAccount, requireAccount } from "@/accounts/server";
import {
	scopedBridgeSession,
	accountBridgeCommand,
} from "@/accounts/bridge-scope";
import {
	settleBridgeRequests,
} from "@/accounts/bridge-transport";
import {
	BridgeSnapshotCache,
	type BridgeSnapshot,
} from "@/accounts/bridge-snapshot-cache";
import { readBoundedBody } from "@/accounts/request-body";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const commandBatchSchema = z
	.object({ commands: z.array(z.unknown()).optional(), cancelledCommandIds: z.array(z.string()).optional() })
	.passthrough();
const commandCompletionSchema = z
	.object({ accepted: z.boolean().optional() })
	.passthrough();
const heartbeatSchema = z
	.object({
		projectId: z.string().min(1),
		projectName: z.string().min(1),
		expectedRevision: z.number().int().nonnegative(),
		revision: z.number().int().nonnegative(),
		canonicalRevision: z.number().int().nonnegative().optional(),
		dirty: z.boolean(),
		playback: z.unknown(),
		selection: z.unknown(),
		ui: z.unknown(),
	})
	.strict();
const legacySnapshots = new BridgeSnapshotCache();

type RouteContext = {
	params: Promise<{ path: string[] }>;
};

async function proxyBridgeRequest({
	request,
	context,
}: {
	request: Request;
	context: RouteContext;
}): Promise<Response> {
	const requestUrl = new URL(request.url);
	if (!isLoopbackHostname(requestUrl.hostname)) {
		return NextResponse.json(
			{ error: "The POCUT MCP bridge is available only on localhost" },
			{ status: 403 },
		);
	}

	let configs: BridgeConfig[];
	try {
		configs = await loadBridgeConfigs();
	} catch {
		return NextResponse.json(
			{
				error:
					"POCUT MCP is not running. Start or reconnect Codex, then reload the editor.",
			},
			{ status: 503 },
		);
	}

	const { path: inputPath } = await context.params;
	const path = [...inputPath];
	if (
		path.length === 0 ||
		path.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment))
	) {
		return NextResponse.json({ error: "Invalid bridge path" }, { status: 400 });
	}
	const permitted =
		(request.method === "PUT" && path.length === 1 && path[0] === "state") ||
		(request.method === "GET" && path.length === 1 && path[0] === "status") ||
		(path.length === 2 &&
			((request.method === "GET" && path[0] === "commands") ||
				(request.method === "POST" &&
					["results", "heartbeat"].includes(path[0])) ||
				(request.method === "DELETE" && path[0] === "session")));
	if (!permitted)
		return NextResponse.json(
			{ error: "Unsupported bridge operation" },
			{ status: 400 },
		);
	const accountId = requireAccount().id;
	let body: ArrayBuffer | undefined;
	let legacyHeartbeatBody: ArrayBuffer | undefined;
	let legacyBody: ArrayBuffer | undefined;
	try {
		body =
			request.method === "GET"
				? undefined
				: await readBoundedBody({
						request: request,
						maximumBytes:
							path[0] === "heartbeat" ? 512 * 1024 : 32 * 1024 * 1024,
					});
		if (path[0] === "state" && body) {
			const snapshot = JSON.parse(new TextDecoder().decode(body));
			snapshot.sessionId = scopedBridgeSession({
				accountId: accountId,
				sessionId: snapshot.sessionId,
			});
			body = new TextEncoder().encode(JSON.stringify(snapshot)).buffer;
			legacyBody = legacyBridgeBody({body,operation:"state"});
			legacySnapshots.remember({
				snapshot: JSON.parse(new TextDecoder().decode(legacyBody)) as BridgeSnapshot,
				bytes: legacyBody.byteLength,
			});
		} else if (path.length === 2) {
			path[1] = scopedBridgeSession({ accountId, sessionId: path[1] });
			if (path[0] === "heartbeat" && body) {
				legacyBody = legacyBridgeBody({body,operation:"heartbeat"});
				const value = heartbeatSchema.parse(
					JSON.parse(new TextDecoder().decode(body)),
				);
				const snapshot = legacySnapshots.heartbeat({
					sessionId: path[1],
					value: {...value, canonicalRevision: undefined},
				});
				if (snapshot) {
					const encoded = new TextEncoder().encode(JSON.stringify(snapshot));
					if (encoded.byteLength <= 2 * 1024 * 1024)
						legacyHeartbeatBody = encoded.buffer;
					else legacySnapshots.forget({ sessionId: path[1] });
				}
			}
			if (request.method === "DELETE")
				legacySnapshots.forget({ sessionId: path[1] });
		}
	} catch {
		return NextResponse.json(
			{ error: "Invalid account bridge request" },
			{ status: 400 },
		);
	}
	const contentType = request.headers.get("content-type");

	const responses = (
		await settleBridgeRequests({
			configs,
			// Long polls carry no snapshot bytes and must remain parallel.
			concurrency: request.method === "GET" ? configs.length : 4,
			run: (config) => {
				if (path[0] === "heartbeat" && !config.supportsHeartbeat) {
					if (!legacyHeartbeatBody)
						return Promise.resolve(new Response(null, { status: 204 }));
					return fetchBridge({
						config,
						path: ["state"],
						method: "PUT",
						contentType,
						body: legacyHeartbeatBody,
					});
				}
				return fetchBridge({
					config,
					path,
					method: request.method,
					contentType,
					body: !config.supportsCanonicalInvocation && legacyBody ? legacyBody : body,
				});
			},
		})
	)
		.filter(
			(result): result is PromiseFulfilledResult<Response> =>
				result.status === "fulfilled",
		)
		.map((result) => result.value);
	const successful = responses.filter(
		(response) => response.ok && response.status !== 204,
	);
	await Promise.allSettled(
		responses
			.filter((response) => !response.ok)
			.map((response) => response.body?.cancel()),
	);
	const needsFullState =
		path[0] === "heartbeat" &&
		responses.some(
			(response) => response.status === 404 || response.status === 409,
		);
	if (successful.length === 0) {
		// A bridge process can restart between cache refreshes. Force the next
		// request to discover its new loopback endpoint immediately.
		invalidateBridgeConfigs();
		return NextResponse.json(
			{ error: "The POCUT MCP bridge stopped responding" },
			{ status: 503 },
		);
	}

	if (
		(request.method === "PUT" && path[0] === "state") ||
		path[0] === "heartbeat"
	) {
		await Promise.allSettled(
			successful.map((response) => response.body?.cancel()),
		);
		return NextResponse.json({
			connected: true,
			bridgeCount: successful.length,
			needsFullState,
		});
	}

	if (request.method === "GET" && path[0] === "commands") {
		const batches = await Promise.all(
			successful.map(async (response) => {
				try {
					return commandBatchSchema.parse(await response.json());
				} catch {
					return {};
				}
			}),
		);
		return NextResponse.json({
			cancelledCommandIds: batches.flatMap((batch) => batch.cancelledCommandIds ?? []),
			commands: batches
				.flatMap((batch) => batch.commands ?? [])
				.map((command) =>
					accountBridgeCommand({ accountId: accountId, value: command }),
				),
		});
	}

	if (request.method === "POST" && path[0] === "results") {
		const completions = await Promise.all(
			successful.map(async (response) => {
				try {
					return commandCompletionSchema.parse(await response.json());
				} catch {
					return {};
				}
			}),
		);
		if (completions.some((completion) => completion.accepted)) {
			return NextResponse.json({ accepted: true });
		}
		return NextResponse.json(
			{ error: "command or session was not found" },
			{ status: 404 },
		);
	}

	if (request.method === "DELETE" && path[0] === "session") {
		return NextResponse.json({ connected: false });
	}

	if (request.method === "GET" && path[0] === "status") {
		const statuses = await Promise.all(
			successful.map(async (response) => {
				try {
					return bridgeStatusSchema.parse(await response.json());
				} catch {
					return {};
				}
			}),
		);
		return NextResponse.json({
			healthy: statuses.some((status) => status.healthy),
			supportsCanonicalInvocation: statuses.some((status) => status.supportsCanonicalInvocation),
			connected: statuses.some((status) => status.connected),
			bridgeCount: successful.length,
		});
	}

	const response = successful[0]!;
	return new Response(response.body, {
		status: response.status,
		headers: {
			"Content-Type":
				response.headers.get("content-type") ?? "application/json",
			"Cache-Control": "no-store",
		},
	});
}

// Next.js requires positional request/context parameters for route handlers.
// eslint-disable-next-line opencut/prefer-object-params
function GETHandler(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
function PUTHandler(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
function POSTHandler(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
function DELETEHandler(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

export const GET = withAccount(GETHandler);

export const PUT = withAccount(PUTHandler);

export const POST = withAccount(POSTHandler);

export const DELETE = withAccount(DELETEHandler);
