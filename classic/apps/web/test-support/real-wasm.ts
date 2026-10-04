import { mock } from "bun:test";
import { wasm } from "./wasm";

// The isolated runner preloads this for suites marked @opencut-test-wasm: real.
// Tests with explicit WASM mocks merge `wasm` into their own factory instead,
// so their overrides bind before product modules are imported.
mock.module("opencut-wasm", () => wasm);
