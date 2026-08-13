import { describe, expect, test } from "bun:test";
import {
	detectRuntimeTarget,
	getWasmThreadCount,
} from "./runtime-profile";

describe("runtime performance profile", () => {
	test("keeps a regular web build on the browser path", () => {
		expect(
			detectRuntimeTarget({
				builtTarget: "browser",
				userAgent: "Mozilla/5.0 Chrome/140",
			}),
		).toBe("browser");
	});

	test("detects Electron in shared development mode", () => {
		expect(
			detectRuntimeTarget({
				builtTarget: "browser",
				userAgent: "Mozilla/5.0 OpenCutElectron/0.1.0",
			}),
		).toBe("electron");
	});

	test("reserves one core and gives Electron the larger compute budget", () => {
		expect(
			getWasmThreadCount({
				crossOriginIsolated: true,
				hardwareConcurrency: 16,
				target: "browser",
			}),
		).toBe(4);
		expect(
			getWasmThreadCount({
				crossOriginIsolated: true,
				hardwareConcurrency: 16,
				target: "electron",
			}),
		).toBe(8);
	});

	test("falls back to one WASM thread without cross-origin isolation", () => {
		expect(
			getWasmThreadCount({
				crossOriginIsolated: false,
				hardwareConcurrency: 16,
				target: "electron",
			}),
		).toBe(1);
	});
});
