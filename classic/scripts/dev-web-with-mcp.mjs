import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const classicRoot = resolve(import.meta.dirname, "..");
const webRoot = resolve(classicRoot, "apps/web");
const runner = resolve(classicRoot, "scripts/mcp-bridge-runner.mjs");
const bun = process.platform === "win32" ? "bun.exe" : "bun";

function start(command, args, cwd) {
	return spawn(command, args, {
		cwd,
		stdio: "inherit",
		windowsHide: true,
	});
}

let mcp = null;
let next = null;
let stopping = false;

function stop() {
	if (stopping) return;
	stopping = true;
	for (const child of [next, mcp]) {
		if (child && child.exitCode === null) child.kill();
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => {
		stop();
		process.exitCode = 0;
	});
}

if (!existsSync(resolve(classicRoot, "rust/wasm/pkg/opencut_wasm_bg.wasm"))) {
	const wasm = start(bun, ["run", "build:wasm"], classicRoot);
	const wasmCode = await new Promise((resolvePromise) =>
		wasm.once("exit", (code) => resolvePromise(code ?? 1)),
	);
	if (wasmCode !== 0) process.exit(wasmCode);
}

mcp = start(process.execPath, [runner], classicRoot);
next = start(bun, ["run", "next", "dev", "--turbopack"], webRoot);

const exitCode = await new Promise((resolvePromise) => {
	let settled = false;
	const settle = (code) => {
		if (settled) return;
		settled = true;
		resolvePromise(code ?? 1);
	};
	next.once("exit", settle);
	mcp.once("exit", (code) => {
		if (!stopping && code !== 0) settle(code);
	});
});

stop();
process.exit(exitCode);
