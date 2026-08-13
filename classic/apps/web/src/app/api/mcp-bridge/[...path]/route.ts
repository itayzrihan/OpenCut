import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bridgeConfigSchema = z
	.object({
		version: z.literal(1),
		baseUrl: z.url(),
		token: z.string().min(32),
		pid: z.number().int().positive(),
		createdAtMs: z.number().int().nonnegative(),
	})
	.strict();
const commandBatchSchema = z
	.object({ commands: z.array(z.unknown()).optional() })
	.passthrough();
const commandCompletionSchema = z
	.object({ accepted: z.boolean().optional() })
	.passthrough();
const bridgeStatusSchema = z
	.object({
		healthy: z.boolean().optional(),
		connected: z.boolean().optional(),
	})
	.passthrough();

type RouteContext = {
	params: Promise<{ path: string[] }>;
};

type BridgeConfig = z.infer<typeof bridgeConfigSchema>;

function bridgeConfigDirectories(): string[] {
	const home = homedir();
	const directories = [
		process.env.LOCALAPPDATA
			? join(process.env.LOCALAPPDATA, "OpenCut")
			: undefined,
		process.platform === "win32" && home
			? join(home, "AppData", "Local", "OpenCut")
			: undefined,
		process.env.XDG_RUNTIME_DIR
			? join(process.env.XDG_RUNTIME_DIR, "opencut")
			: undefined,
		home ? join(home, ".opencut") : undefined,
		join(tmpdir(), "opencut"),
	];
	return [
		...new Set(
			directories.filter((directory): directory is string => Boolean(directory)),
		),
	];
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function validateBridgeConfig(raw: string): BridgeConfig | null {
	try {
		const config = bridgeConfigSchema.parse(JSON.parse(raw));
		const target = new URL(config.baseUrl);
		if (
			target.protocol !== "http:" ||
			!isLoopbackHostname(target.hostname) ||
			target.username ||
			target.password
		) {
			return null;
		}
		return config;
	} catch {
		return null;
	}
}

async function loadBridgeConfigs(): Promise<BridgeConfig[]> {
	const paths: string[] = [];
	for (const directory of bridgeConfigDirectories()) {
		paths.push(join(directory, "mcp-classic-bridge.json"));
		try {
			const entries = await readdir(join(directory, "mcp-classic-bridges"), {
				withFileTypes: true,
			});
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".json")) {
					paths.push(join(directory, "mcp-classic-bridges", entry.name));
				}
			}
		} catch {
			// This MCP instance directory has not been created yet.
		}
	}

	const configs = (
		await Promise.all(
			[...new Set(paths)].map(async (path) => {
				try {
					return validateBridgeConfig(await readFile(path, "utf8"));
				} catch {
					return null;
				}
			}),
		)
	).filter((config): config is BridgeConfig => config !== null);
	const uniqueConfigs = new Map<string, BridgeConfig>();
	for (const config of configs) {
		uniqueConfigs.set(`${config.baseUrl}\u0000${config.token}`, config);
	}
	const sorted = [...uniqueConfigs.values()].sort(
		(left, right) => right.createdAtMs - left.createdAtMs,
	);
	if (sorted.length === 0) {
		throw new Error("The OpenCut MCP bridge config was not found");
	}
	return sorted;
}

async function fetchBridge({
	config,
	path,
	method,
	contentType,
	body,
}: {
	config: BridgeConfig;
	path: string[];
	method: string;
	contentType: string | null;
	body?: ArrayBuffer;
}) {
	const target = new URL(`/bridge/${path.join("/")}`, config.baseUrl);
	return fetch(target, {
		method,
		headers: {
			Authorization: `Bearer ${config.token}`,
			...(contentType ? { "Content-Type": contentType } : {}),
		},
		body: body?.slice(0),
		cache: "no-store",
		signal: AbortSignal.timeout(50_000),
	});
}

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
			{ error: "The OpenCut MCP bridge is available only on localhost" },
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
					"OpenCut MCP is not running. Start or reconnect Codex, then reload the editor.",
			},
			{ status: 503 },
		);
	}

	const { path } = await context.params;
	if (
		path.length === 0 ||
		path.some((segment) => !/^[a-zA-Z0-9._-]+$/.test(segment))
	) {
		return NextResponse.json({ error: "Invalid bridge path" }, { status: 400 });
	}
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await request.arrayBuffer();
	const contentType = request.headers.get("content-type");

	const responses = (
		await Promise.allSettled(
			configs.map((config) =>
				fetchBridge({
					config,
					path,
					method: request.method,
					contentType,
					body,
				}),
			),
		)
	)
		.filter(
			(result): result is PromiseFulfilledResult<Response> =>
				result.status === "fulfilled",
		)
		.map((result) => result.value);
	const successful = responses.filter((response) => response.ok);
	if (successful.length === 0) {
		return NextResponse.json(
			{ error: "The OpenCut MCP bridge stopped responding" },
			{ status: 503 },
		);
	}

	if (request.method === "PUT" && path[0] === "state") {
		return NextResponse.json({
			connected: true,
			bridgeCount: successful.length,
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
			commands: batches.flatMap((batch) => batch.commands ?? []),
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
export function GET(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
export function PUT(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
export function POST(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}

// eslint-disable-next-line opencut/prefer-object-params
export function DELETE(request: Request, context: RouteContext) {
	return proxyBridgeRequest({ request, context });
}
