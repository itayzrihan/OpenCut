import {
	isBridgeProcessAlive,
	settleBridgeRequests,
} from "@/accounts/bridge-transport";
import { readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const bridgeConfigSchema = z
	.object({
		// Version 2 binds command completions and disconnects to their session.
		// Older bridges cannot provide the isolation required by local accounts.
		version: z.literal(2),
		supportsHeartbeat: z.boolean().optional(),
		baseUrl: z.url(),
		token: z.string().min(32),
		pid: z.number().int().positive(),
		createdAtMs: z.number().int().nonnegative(),
	})
	.strict();
export const bridgeStatusSchema = z
	.object({
		healthy: z.boolean().optional(),
		supportsCanonicalInvocation: z.boolean().optional(),
		connected: z.boolean().optional(),
	})
	.passthrough();

export type BridgeConfig = z.infer<typeof bridgeConfigSchema> & {
	supportsCanonicalInvocation?: boolean;
};
const peerProtocols = new Map<string, boolean>();

const BRIDGE_CONFIG_CACHE_MS = 5_000;
let bridgeConfigCache:
	| { expiresAtMs: number; configs: BridgeConfig[] }
	| undefined;

export function invalidateBridgeConfigs(): void {
	bridgeConfigCache = undefined;
}

function bridgeConfigDirectories(): string[] {
	const home = homedir();
	const directories = [
		process.env.OPENCUT_CLASSIC_BRIDGE_DIRECTORY,
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
			directories.filter((directory): directory is string =>
				Boolean(directory),
			),
		),
	];
}

export function isLoopbackHostname(hostname: string): boolean {
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
		return isBridgeProcessAlive({ pid: config.pid }) ? config : null;
	} catch {
		return null;
	}
}

export async function loadBridgeConfigs(): Promise<BridgeConfig[]> {
	const now = Date.now();
	if (bridgeConfigCache && bridgeConfigCache.expiresAtMs > now) {
		return bridgeConfigCache.configs;
	}

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
		throw new Error("The POCUT MCP bridge config was not found");
	}
	const negotiations = await settleBridgeRequests({
		configs: sorted,
		concurrency: 4,
		run: async (config): Promise<BridgeConfig> => {
			const key = `${config.pid}:${config.token}`;
			let supportsCanonicalInvocation = peerProtocols.get(key);
			if (supportsCanonicalInvocation === undefined) {
				try {
					const response = await fetchBridge({
						config,
						path: ["status"],
						method: "GET",
						contentType: null,
						timeoutMs: 1500,
					});
					if (!response.ok) {
						await response.body?.cancel();
						return config;
					}
					supportsCanonicalInvocation =
						bridgeStatusSchema.parse(await response.json())
							.supportsCanonicalInvocation === true;
					peerProtocols.set(key, supportsCanonicalInvocation);
					if (peerProtocols.size > 64)
						peerProtocols.delete(peerProtocols.keys().next().value!);
				} catch {
					return config;
				}
			}
			return { ...config, supportsCanonicalInvocation };
		},
	});
	const negotiated = negotiations.map((result, index) =>
		result.status === "fulfilled" ? result.value : sorted[index]!,
	);
	bridgeConfigCache = {
		expiresAtMs: now + BRIDGE_CONFIG_CACHE_MS,
		configs: negotiated,
	};
	return negotiated;
}

export async function fetchBridge({
	config,
	path,
	method,
	contentType,
	body,
	timeoutMs = 50_000,
	signal,
}: {
	config: BridgeConfig;
	path: string[];
	method: string;
	contentType: string | null;
	body?: ArrayBuffer;
	timeoutMs?: number;
	signal?: AbortSignal;
}) {
	const target = new URL(`/bridge/${path.join("/")}`, config.baseUrl);
	return fetch(target, {
		method,
		headers: {
			Authorization: `Bearer ${config.token}`,
			...(contentType ? { "Content-Type": contentType } : {}),
		},
		body,
		cache: "no-store",
		redirect: "error",
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs),
	});
}
