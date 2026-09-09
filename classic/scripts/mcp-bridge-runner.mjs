import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const classicRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(classicRoot, "..");
const configDirectory = process.env.LOCALAPPDATA
	? join(process.env.LOCALAPPDATA, "OpenCut")
	: join(homedir(), ".opencut");
const configDirectories = [
	...new Set([configDirectory, join(tmpdir(), "opencut")]),
];
const lockPath = join(configDirectory, "mcp-autostart.lock");
let lockHandle = null;
let child = null;
let childStartedAtMs = 0;
let shuttingDown = false;
let resolveShutdown;
const shutdownPromise = new Promise((resolvePromise) => {
	resolveShutdown = resolvePromise;
});

function command(command, args) {
	return spawn(command, args, {
		cwd: workspaceRoot,
		env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" },
		stdio: ["pipe", "inherit", "inherit"],
		windowsHide: true,
	});
}

function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function bridgeIsHealthy() {
	for (const directory of configDirectories) {
		if (await configIsHealthy(join(directory, "mcp-classic-bridge.json"))) {
			return true;
		}
		let entries;
		try {
			entries = await readdir(join(directory, "mcp-classic-bridges"), {
				withFileTypes: true,
			});
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (
				entry.isFile() &&
				entry.name.endsWith(".json") &&
				(await configIsHealthy(
					join(directory, "mcp-classic-bridges", entry.name),
				))
			) {
				return true;
			}
		}
	}
	return false;
}

async function configIsHealthy(path) {
	try {
		const config = JSON.parse(await readFile(path, "utf8"));
		if (config?.version !== 1 || typeof config.baseUrl !== "string")
			return false;
		const response = await fetch(new URL("/bridge/status", config.baseUrl), {
			headers: { Authorization: `Bearer ${config.token}` },
			signal: AbortSignal.timeout(300),
		});
		return response.ok;
	} catch {
		return false;
	}
}

async function recentInstanceIsHealthy() {
	for (const directory of configDirectories) {
		const instanceDirectory = join(directory, "mcp-classic-bridges");
		let entries;
		try {
			entries = await readdir(instanceDirectory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			const path = join(instanceDirectory, entry.name);
			try {
				const config = JSON.parse(await readFile(path, "utf8"));
				if (
					typeof config.createdAtMs === "number" &&
					config.createdAtMs >= childStartedAtMs &&
					(await configIsHealthy(path))
				) {
					return true;
				}
			} catch {
				// Ignore partially written or stale instance descriptors.
			}
		}
	}
	return false;
}

async function pruneStaleConfigs() {
	const candidates = [];
	for (const directory of configDirectories) {
		const instanceDirectory = join(directory, "mcp-classic-bridges");
		try {
			const entries = await readdir(instanceDirectory, { withFileTypes: true });
			candidates.push(
				...entries
					.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
					.map((entry) => join(instanceDirectory, entry.name)),
			);
		} catch {
			// This MCP instance directory has not been created yet.
		}
	}
	const results = await Promise.all(
		candidates.map(async (path) => ({
			path,
			healthy: await configIsHealthy(path),
		})),
	);
	await Promise.all(
		results
			.filter(({ healthy }) => !healthy)
			.map(({ path }) => rm(path, { force: true })),
	);
}

async function acquireLock() {
	await mkdir(dirname(lockPath), { recursive: true });
	for (;;) {
		try {
			lockHandle = await open(lockPath, "wx");
			await lockHandle.writeFile(
				JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
			);
			return true;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const existing = JSON.parse(await readFile(lockPath, "utf8"));
				if (isProcessAlive(existing?.pid)) return false;
			} catch {
				// A partially written or stale lock can be safely replaced.
			}
			await rm(lockPath, { force: true });
		}
	}
}

async function releaseLock() {
	try {
		await lockHandle?.close();
	} finally {
		lockHandle = null;
		await rm(lockPath, { force: true });
	}
}

function spawnMcp() {
	console.log("[mcp] starting through Cargo to keep the binary in sync");
	return command(process.platform === "win32" ? "cargo.exe" : "cargo", [
		"run",
		"--quiet",
		"-p",
		"opencut-mcp-server",
	]);
}

async function waitForBridge() {
	for (let attempt = 0; attempt < 240; attempt += 1) {
		if ((await bridgeIsHealthy()) || (await recentInstanceIsHealthy())) return;
		if (child?.exitCode !== null) {
			throw new Error(`MCP process exited with code ${child.exitCode}`);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error("Timed out waiting for the OpenCut MCP bridge");
}

async function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (child && child.exitCode === null) {
		child.kill();
	}
	if (lockHandle) await releaseLock();
	process.exitCode = code;
	resolveShutdown();
}

function sleep(milliseconds) {
	return new Promise((resolvePromise) =>
		setTimeout(resolvePromise, milliseconds),
	);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => void shutdown(0));
}
process.on("uncaughtException", (error) => {
	console.error(
		`[mcp] ${error instanceof Error ? error.stack : String(error)}`,
	);
	void shutdown(1);
});

try {
	await pruneStaleConfigs();
	while (!shuttingDown) {
		if (await bridgeIsHealthy()) {
			console.log(
				"[mcp] an existing OpenCut Classic bridge is already running",
			);
			while (!shuttingDown && (await bridgeIsHealthy())) await sleep(1000);
			continue;
		}

		const ownsLock = await acquireLock();
		if (!ownsLock) {
			await sleep(250);
			continue;
		}

		childStartedAtMs = Date.now() - 1_000;
		child = spawnMcp();
		child.on("exit", (code, signal) => {
			if (!shuttingDown) {
				console.error(
					`[mcp] exited (code=${code ?? "null"}, signal=${signal ?? "none"})`,
				);
				void shutdown(code && code > 0 ? code : 1);
			}
		});
		await waitForBridge();
		console.log("[mcp] OpenCut Classic bridge is ready");
		await shutdownPromise;
	}
} catch (error) {
	console.error(
		`[mcp] ${error instanceof Error ? error.message : String(error)}`,
	);
	await shutdown(1);
}
