import { spawn } from "node:child_process";
import { resolve } from "node:path";

const classicRoot = resolve(import.meta.dirname, "..");
const electronRoot = resolve(classicRoot, "apps/electron");
const runner = resolve(classicRoot, "scripts/mcp-bridge-runner.mjs");
const electronCli = resolve(electronRoot, "node_modules/electron/cli.js");
const appUrl = process.env.OPENCUT_ELECTRON_URL ?? "http://127.0.0.1:3000";

function start(command, args, cwd, env = process.env) {
	return spawn(command, args, {
		cwd,
		env,
		stdio: "inherit",
		windowsHide: true,
	});
}

async function waitForHttp(url) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(500) });
			if (response.ok) return;
		} catch {
			// The web dev server may still be compiling.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error(`Timed out waiting for ${url}`);
}

const mcp = start(process.execPath, [runner], classicRoot);
let electron = null;
let stopping = false;

function stop() {
	if (stopping) return;
	stopping = true;
	for (const child of [electron, mcp]) {
		if (child && child.exitCode === null) child.kill();
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		stop();
		process.exitCode = 0;
	});
}

try {
	await waitForHttp(appUrl);
	electron = start(process.execPath, [electronCli, "app"], electronRoot, {
		...process.env,
		OPENCUT_ELECTRON_URL: appUrl,
	});
	const exitCode = await new Promise((resolvePromise) =>
		electron.once("exit", (code) => resolvePromise(code ?? 1)),
	);
	stop();
	process.exit(exitCode);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	stop();
	process.exit(1);
}
