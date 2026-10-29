import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(root, ".local/earshot-cargo-target"),
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
    },
  });
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.status ?? result.error}`);
}
run("node", ["classic/scripts/prepare-earshot-runtime.mjs"]);
run(
  "wasm-pack",
  ["build", "--target", "bundler", "--out-dir", "pkg", "--no-pack", "--dev"],
  path.join(root, "classic/rust/editor-runtime-wasm"),
);
run("node", ["classic/scripts/write-wasm-manifests.mjs"]);
run("node", ["classic/scripts/verify-wasm-exports.mjs"]);
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
  "editor_ui",
]);
run("cargo", ["test", "-p", "opencut-mcp", "--test", "earshot_discovery"]);
run("cargo", ["test", "-p", "opencut-mcp", "canonical_transport_tests"]);
run("node", [
  "classic/scripts/test-web.mjs",
  "--jobs=1",
  "--timeout=480000",
  "src/earshot/catalog.test.ts",
  "src/mcp/__tests__/canonical-transport.test.ts",
  "src/editor-agent/__tests__/earshot-preview-effect.test.ts",
  "src/editor-agent/__tests__/earshot-preview-browser.test.ts",
  "src/editor-agent/__tests__/scene-automation-effects.test.ts",
  "src/ai/__tests__/automatic-word-animation-earshot.test.ts",
  "src/core/__tests__/canonical-scene-automation.test.ts",
  "src/batch/server.test.ts",
  "src/accounts/bridge-protocol.test.ts",
  "src/accounts/bridge-scope.test.ts",
  "src/mcp/__tests__/bridge-publication.test.ts",
  "src/mcp/__tests__/bridge-publication-payload.test.ts",
]);
// Exercise the affected real command-manager and agent-host paths. The full
// unrelated manager suite has 80 cases and exceeds the local 8-minute budget.
run(
  "bun",
  [
    "test",
    "--timeout=60000",
    "--preload",
    "./test-support/real-wasm.ts",
    "--test-name-pattern",
    "live canonical MCP|editing agent uses the live registry|rapid steering cancels|client resumes an uncertain host write|editing agent pause and steering",
    "./src/core/managers/__tests__/canonical-command-manager.test.ts",
  ],
  path.join(root, "classic/apps/web"),
);
run(
  "node",
  ["node_modules/typescript/bin/tsc", "--noEmit", "-p", "tsconfig.build.json"],
  path.join(root, "classic/apps/web"),
);
run("git", ["diff", "--check"]);
console.log(
  "Earshot MCP registry, browser host, actual wire transport and automation checks passed.",
);
