#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const report = join(root, ".local/peer-sync-qa/configured");
await mkdir(report, { recursive: true });
const results = [];
async function run(name, command, args, cwd = root) {
	const started = Date.now();
	const result = await new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd,
			windowsHide: true,
			env: {
				...process.env,
				CARGO_BUILD_JOBS: "1",
				CARGO_PROFILE_DEV_DEBUG: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		const timer = setTimeout(() => {
			output += "\nVerification step timed out";
			child.kill();
		}, 600_000);
		child.stdout.on("data", (bytes) => {
			output += bytes.toString();
		});
		child.stderr.on("data", (bytes) => {
			output += bytes.toString();
		});
		child.on("error", (error) => {
			output += String(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? 1, output });
		});
	});
	await writeFile(join(report, `${name}.log`), result.output);
	results.push({
		name,
		exitCode: result.code,
		elapsedMs: Date.now() - started,
	});
	await writeFile(
		join(report, "summary.json"),
		JSON.stringify({ results }, null, 2),
	);
	console.log(`${result.code === 0 ? "PASS" : "FAIL"} ${name}`);
	if (result.code) {
		console.error(result.output.slice(-8000));
		process.exit(1);
	}
}
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo";
await run("wasm-exports", process.execPath, [
	"classic/scripts/verify-wasm-exports.mjs",
]);
await run("native-policy", cargo, [
	"test",
	"--locked",
	"-p",
	"opencut-account-core",
	"--jobs",
	"1",
	"--",
	"--test-threads=1",
]);
await run("native-registry", cargo, [
	"test",
	"--locked",
	"-p",
	"opencut-editor-api",
	"--test",
	"peer_media",
	"--jobs",
	"1",
	"--",
	"--test-threads=1",
]);
await run("web", process.execPath, [
	"classic/scripts/test-web.mjs",
	"src/peer-sync/crypto-relay.test.ts",
	"src/peer-sync/identity.test.ts",
	"src/peer-sync/download.test.ts",
	"src/peer-sync/editor-effect.test.ts",
	"src/peer-sync/canonical-commit.test.ts",
	"src/accounts/legitate-server.test.ts",
	"src/accounts/legitate-start.test.ts",
	"src/accounts/legitate-only-api.test.ts",
	"src/accounts/legitate-callback.test.ts",
	"src/accounts/legitate-session.test.ts",
	"src/accounts/storage-host.test.ts",
	"src/editor-agent/__tests__/host-effects.test.ts",
	"src/editor-agent/__tests__/deepseek-harness.test.ts",
	"src/editor-agent/__tests__/dsh-schema-runtime.test.ts",
	"src/core/managers/__tests__/canonical-command-manager.test.ts",
	"src/core/managers/__tests__/project-session-lifecycle.test.ts",
	"--jobs=1",
	"--timeout=480000",
	"--test-timeout=60000",
	`--report=${join(report, "web")}`,
]);
await run(
	"production-types",
	process.execPath,
	[
		"node_modules/typescript/bin/tsc",
		"--noEmit",
		"--project",
		"tsconfig.build.json",
	],
	resolve(root, "classic/apps/web"),
);
await run(
	"feature-test-types",
	process.execPath,
	[
		"node_modules/typescript/bin/tsc",
		"--noEmit",
		"--project",
		"tsconfig.peer-sync-test.json",
	],
	resolve(root, "classic/apps/web"),
);
console.log(`Peer-media checks passed. Evidence: ${report}`);
