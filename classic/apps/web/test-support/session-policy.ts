// Load the actual canonical WASM policy for Node/Bun filesystem host tests.
import { mock } from "bun:test";
import { createCanonicalTestRuntime } from "../src/core/__tests__/canonical-runtime-fixture";
const runtime = await createCanonicalTestRuntime();
runtime.free();
const glue =
	await import("../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
mock.module("opencut-editor-runtime-wasm", () => ({
	sessionStoreTransition: glue.sessionStoreTransition,
}));
