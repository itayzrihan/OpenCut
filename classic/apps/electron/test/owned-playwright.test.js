import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

test("internal Playwright operates only on the owned Electron window", async () => {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	const result = await new Promise((resolve, reject) => {
		const child = spawn(
			require("electron"),
			[
				fileURLToPath(
					new URL("./owned-playwright-fixture.cjs", import.meta.url),
				),
			],
			{
				env,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Electron fixture timed out\n${output}`));
		}, 45000);
		child.stdout.on("data", (data) => {
			output += data;
		});
		child.stderr.on("data", (data) => {
			output += data;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
	expect(result.output).toContain('"type":"owned-playwright-pass"');
	expect(result.code).toBe(0);
}, 50000);
