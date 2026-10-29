import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const web = path.join(root, "classic/apps/web");
const env = {
	...process.env,
	CARGO_TARGET_DIR:
		process.env.CARGO_TARGET_DIR ||
		path.join(root, ".local/earshot-cargo-target"),
	CARGO_PROFILE_DEV_DEBUG: "0",
	CARGO_INCREMENTAL: "0",
	CARGO_BUILD_JOBS: "2",
	OPENCUT_EARSHOT_EXPORT_TEST: "1",
};
function run(command, args, cwd = root) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		stdio: "inherit",
		timeout: 600_000,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}

run("node", ["classic/scripts/prepare-earshot-runtime.mjs"]);
run("wasm-pack", [
	"build",
	"classic/rust/editor-runtime-wasm",
	"--target",
	"bundler",
	"--out-dir",
	"pkg",
	"--no-pack",
	"--dev",
]);
run("node", ["classic/scripts/write-wasm-manifests.mjs"]);
run("node", ["classic/scripts/verify-wasm-exports.mjs"]);
run(
	"node",
	[
		"--input-type=module",
		"-e",
		'import { createBuilder } from "@content-collections/core"; await (await createBuilder("content-collections.ts")).build();',
	],
	web,
);
run("cargo", [
	"test",
	"-p",
	"opencut-editor-api",
	"--test",
	"earshot_library",
	"--test",
	"earshot_preview",
	"--test",
	"classic_procedural_audio",
	"--test",
	"classic_automation_host",
	"--test",
	"classic_scenes",
	"--test",
	"classic_takes",
	"--test",
	"editor_ui",
]);
run("cargo", [
	"test",
	"-p",
	"opencut-editor-agent",
	"--test",
	"permissions",
	"--test",
	"runtime",
	"--test",
	"harness",
]);
run("cargo", ["test", "-p", "opencut-mcp", "--test", "earshot_discovery"]);
run("cargo", ["test", "-p", "opencut-mcp", "canonical_transport_tests"]);
run("node", ["--test", "classic/apps/electron/test/agent-computer.test.js"]);
run("node", [
	"classic/scripts/test-web.mjs",
	"--jobs=1",
	"--test-timeout=60000",
	"--timeout=360000",
	"src/editor-agent/__tests__/deepseek-earshot.test.ts",
	"src/editor-agent/__tests__/deepseek-harness.test.ts",
	"src/editor-agent/__tests__/deepseek-canonical.test.ts",
	"src/editor-agent/__tests__/permissions.test.ts",
	"src/editor-agent/__tests__/connection.test.ts",
	"src/editor-agent/__tests__/stream.test.ts",
	"src/editor-agent/__tests__/transport.test.ts",
	"src/editor-agent/__tests__/host-effects.test.ts",
	"src/editor-agent/__tests__/checkpoint.test.ts",
	"src/editor-agent/__tests__/earshot-preview-effect.test.ts",
	"src/editor-agent/__tests__/earshot-preview-browser.test.ts",
	"src/editor-agent/__tests__/scene-automation-effects.test.ts",
	"src/mcp/__tests__/canonical-transport.test.ts",
	"src/mcp/__tests__/bridge-publication-payload.test.ts",
	"src/accounts/bridge-protocol.test.ts",
	"src/accounts/bridge-scope.test.ts",
	"src/earshot/catalog.test.ts",
	"src/earshot/__tests__/timeline-audio.test.ts",
	"src/earshot/__tests__/export-browser.test.ts",
	"src/ai/__tests__/automatic-sound-effects.test.ts",
	"src/ai/__tests__/automatic-word-animation-earshot.test.ts",
	"src/ai/__tests__/earshot-repository.test.ts",
	"src/ai/__tests__/full-auto-edit-resume.test.ts",
	"src/ai/__tests__/full-auto-edit-routed.test.ts",
	"src/ai/__tests__/full-auto-edit-takes.test.ts",
	"src/core/__tests__/canonical-scene-automation.test.ts",
	"src/core/__tests__/canonical-smart-takes.test.ts",
	"src/batch/server.test.ts",
]);
run(
	"bun",
	[
		"test",
		"--timeout=60000",
		"--preload",
		"./test-support/real-wasm.ts",
		"--test-name-pattern",
		"live canonical MCP|streamed provider loop|rapid steering|uncertain host write|failed edit retains|disposing an idle agent|editing agent pause and steering",
		"./src/core/managers/__tests__/canonical-command-manager.test.ts",
	],
	web,
);
run(
	"node",
	["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.build.json"],
	web,
);
run("git", ["-c", "core.whitespace=cr-at-eol", "diff", "--check"]);
console.log(
	"Verified merged Earshot + DeepSeek Harness + canonical MCP, permission boundaries, main regression cases and actual procedural MP4 audio export.",
);
