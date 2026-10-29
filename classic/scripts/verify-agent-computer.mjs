import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const classic = join(root, "classic");
function run(command, args, cwd = root, env = {}) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, ...env },
		timeout: 240000,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
run(
	"cargo",
	[
		"test",
		"-p",
		"opencut-editor-agent",
		"--test",
		"permissions",
		"--test",
		"runtime",
		"--quiet",
	],
	root,
	{ CARGO_INCREMENTAL: "0", CARGO_BUILD_JOBS: "2" },
);
run(process.execPath, [
	"--test",
	"classic/apps/electron/test/agent-computer.test.js",
]);
run(
	process.execPath,
	[
		"scripts/test-web.mjs",
		"apps/web/src/editor-agent/__tests__/permissions.test.ts",
		"apps/web/src/editor-agent/__tests__/deepseek-harness.test.ts",
		"apps/web/src/editor-agent/__tests__/deepseek-canonical.test.ts",
		"apps/web/src/editor-agent/__tests__/connection.test.ts",
		"apps/web/src/editor-agent/__tests__/stream.test.ts",
		"apps/web/src/editor-agent/__tests__/transport.test.ts",
		"apps/web/src/editor-agent/__tests__/host-effects.test.ts",
		"apps/web/src/editor-agent/__tests__/checkpoint.test.ts",
		"--test-timeout=60000",
		"--timeout=240000",
		"--jobs=1",
		"--report=.local/agent-computer-verification",
	],
	classic,
);
run(
	process.execPath,
	[
		"node_modules/typescript/bin/tsc",
		"--noEmit",
		"-p",
		"apps/web/tsconfig.build.json",
	],
	classic,
);
run(
	process.execPath,
	[
		"../../node_modules/eslint/bin/eslint.js",
		"src/editor-agent/overlay.tsx",
		"src/editor-agent/host-effects.ts",
		"src/core/agent-protocol.ts",
		"src/types/electron-bridge.d.ts",
	],
	join(classic, "apps/web"),
);
run("git", [
	"-c",
	"core.whitespace=cr-at-eol",
	"diff",
	"--check",
	"--",
	"classic",
	"crates",
]);
console.log(
	"Verified canonical modes and approvals, Electron file/shell permissions, cancellation and replay, Harness/Codex connection regressions, TypeScript and targeted lint.",
);
