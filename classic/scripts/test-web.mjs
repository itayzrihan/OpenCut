#!/usr/bin/env node
// Bun's module mocks share a process-wide registry. Keep each suite in its own
// process so renderer, storage and WASM mocks cannot alter another suite.
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const testPattern = /\.(test|spec)\.tsx?$/;
const args = process.argv.slice(2);
let jobs = 2;
let timeoutMs = 90_000;
let report = fileURLToPath(
	new URL(`../../.local/classic-web-tests/${Date.now()}/`, import.meta.url),
);
const requested = [];
for (const arg of args) {
	if (arg.startsWith("--jobs=")) jobs = Number(arg.slice(7));
	else if (arg.startsWith("--timeout=")) timeoutMs = Number(arg.slice(10));
	else if (arg.startsWith("--report=")) report = path.resolve(arg.slice(9));
	else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
	else requested.push(arg);
}
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 8)
	throw new Error("--jobs must be an integer from 1 to 8");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
	throw new Error("--timeout must be a positive number of milliseconds");

async function discover(directory) {
	const files = [];
	for (const item of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, item.name);
		if (item.isDirectory()) files.push(...(await discover(file)));
		else if (item.isFile() && testPattern.test(item.name)) files.push(file);
	}
	return files;
}
const allFiles = (await discover(path.join(webRoot, "src"))).sort();
const files = requested.length
	? [
			...new Set(
				requested.map((name) => {
					const candidate = path.resolve(webRoot, name);
					const fromCwd = path.resolve(name);
					const file = allFiles.find(
						(file) => file === candidate || file === fromCwd,
					);
					if (!file) throw new Error(`Not a web test file: ${name}`);
					return file;
				}),
			),
		]
	: allFiles;
await mkdir(report, { recursive: true });
const started = Date.now();
const results = [];
let next = 0;

async function run(file) {
	const start = Date.now();
	const relative = path.relative(webRoot, file).replaceAll("\\", "/");
	const log = relative.replaceAll("/", "__") + ".log";
	const source = await readFile(file, "utf8");
	const usesNode = /^\/\/ @opencut-test-runner: node\r?$/m.test(source);
	const usesRealWasm = /^\/\/ @opencut-test-wasm: real\r?$/m.test(source);
	if (usesNode && usesRealWasm)
		throw new Error(`Node suites must initialize their own WASM: ${relative}`);
	const runner = usesNode ? "node" : "bun";
	const executable = usesNode ? process.execPath : process.env.BUN_BIN || "bun";
	const runnerArgs = usesNode
		? [
				"--import",
				pathToFileURL(path.join(webRoot, "test-support/node-typescript.mjs")).href,
				"--test",
				"--test-reporter=tap",
			]
		: ["test"];
	if (usesRealWasm)
		runnerArgs.push(
			"--preload",
			path.join(webRoot, "test-support/real-wasm.ts"),
		);
	runnerArgs.push(`./${relative}`);
	const result = await new Promise((resolve) => {
		const child = spawn(executable, runnerArgs, {
			cwd: webRoot,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		child.on("error", (error) => {
			output += `\n${error.message}\n`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) output += `\nSuite timed out after ${timeoutMs} ms\n`;
			resolve({ exitCode: timedOut ? 124 : (code ?? 1), output });
		});
	});
	await writeFile(path.join(report, log), result.output, "utf8");
	const count = (kind) => {
		const pattern = usesNode
			? `^# ${kind === "skip" ? "skipped" : kind} (\\d+)\\b`
			: `^\\s*(\\d+) ${kind}\\b`;
		return Number(result.output.match(new RegExp(pattern, "m"))?.[1] ?? 0);
	};
	const entry = {
		file: relative,
		runner,
		wasm: usesRealWasm ? "real" : "suite",
		exitCode: result.exitCode,
		passed: count("pass"),
		failed: count("fail"),
		skipped: count("skip"),
		milliseconds: Date.now() - start,
		log,
	};
	results.push(entry);
	if (entry.exitCode)
		console.error(`FAIL ${relative}\n${result.output.trim()}\n`);
	else if (requested.length)
		console.log(
			`PASS ${relative} (${entry.passed} passed, ${entry.skipped} skipped)`,
		);
	else if (results.length % 25 === 0)
		console.log(`${results.length}/${files.length} suites complete`);
}
await Promise.all(
	Array.from({ length: Math.min(jobs, files.length) }, async () => {
		while (next < files.length) await run(files[next++]);
	}),
);
results.sort((a, b) => a.file.localeCompare(b.file));
const summary = {
	suites: files.length,
	failedSuites: results.filter((result) => result.exitCode !== 0).length,
	passed: results.reduce((sum, result) => sum + result.passed, 0),
	failed: results.reduce((sum, result) => sum + result.failed, 0),
	skipped: results.reduce((sum, result) => sum + result.skipped, 0),
	milliseconds: Date.now() - started,
	results,
};
await writeFile(
	path.join(report, "summary.json"),
	JSON.stringify(summary, null, 2) + "\n",
);
console.log(
	`${summary.suites} suites: ${summary.failedSuites} failed; ${summary.passed} tests passed, ${summary.failed} failed, ${summary.skipped} skipped (${(summary.milliseconds / 1000).toFixed(1)}s)`,
);
console.log(`Report: ${path.join(report, "summary.json")}`);
process.exitCode = summary.failedSuites ? 1 : 0;
