import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const classic = fileURLToPath(new URL("../", import.meta.url));
function run(command, args, cwd = classic) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		timeout: 240_000,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} failed`);
}

// Generate the declarations required by the repository's existing changelog.
run(
	process.execPath,
	[
		"--input-type=module",
		"-e",
		'import { createBuilder } from "@content-collections/core"; await (await createBuilder("content-collections.ts")).build();',
	],
	join(classic, "apps/web"),
);

run(process.execPath, [
	"scripts/test-web.mjs",
	"apps/web/src/editor-agent/__tests__/deepseek-harness.test.ts",
	"apps/web/src/editor-agent/__tests__/deepseek-canonical.test.ts",
	"apps/web/src/editor-agent/__tests__/connection.test.ts",
	"apps/web/src/editor-agent/__tests__/stream.test.ts",
	"apps/web/src/editor-agent/__tests__/transport.test.ts",
	"apps/web/src/editor-agent/__tests__/host-effects.test.ts",
	"apps/web/src/editor-agent/__tests__/checkpoint.test.ts",
	"--test-timeout=60000",
	"--timeout=120000",
	"--jobs=2",
	"--report=.local/deepseek-harness-verification",
]);
run(process.execPath, [
	"node_modules/typescript/bin/tsc",
	"--noEmit",
	"-p",
	"apps/web/tsconfig.build.json",
]);
run(
	"bun",
	[
		"test",
		"--preload",
		"./test-support/real-wasm.ts",
		"--test-name-pattern",
		"streamed provider loop|rapid steering|uncertain host write|failed edit retains|disposing an idle agent",
		"src/core/managers/__tests__/canonical-command-manager.test.ts",
	],
	join(classic, "apps/web"),
);
run("git", ["diff", "--check", "--", "classic"]);

const dependencies = JSON.parse(
	await readFile(join(classic, "apps/web/package.json"), "utf8"),
).dependencies;
assert.equal(dependencies["@deepseek-ai/dsh-agent-loop"], "0.2.2-alpha.2");
assert.equal(
	dependencies["@deepseek-ai/dsh-tool-executor-native"],
	"0.2.2-alpha.2",
);
console.log(
	"Verified DeepSeek scheduling, canonical project edits, recovery boundaries and unchanged Codex connection contracts.",
);
