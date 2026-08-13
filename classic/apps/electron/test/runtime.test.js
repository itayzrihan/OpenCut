import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import runtime from "../app/runtime.cjs";

const {
	DEFAULT_DISK_CACHE_SIZE_BYTES,
	getAppUrl,
	getElectronUserAgent,
	getPackagedServer,
	getPerformanceProfile,
	waitForHttp,
} = runtime;

describe("Electron runtime", () => {
	test("uses the loopback interface", () => {
		expect(getAppUrl()).toBe("http://127.0.0.1:3000");
		expect(getAppUrl(4312)).toBe("http://127.0.0.1:4312");
	});

	test("matches the electron-builder standalone layout", () => {
		const resources = join("tmp", "resources");
		expect(getPackagedServer(resources)).toEqual({
			root: join(resources, "app-server"),
			entry: join(resources, "app-server", "apps", "web", "server.js"),
		});
	});

	test("uses the high-throughput Electron profile by default", () => {
		expect(getPerformanceProfile({})).toEqual({
			commandLineSwitches: [
				["disk-cache-size", `${DEFAULT_DISK_CACHE_SIZE_BYTES}`],
				["force_high_performance_gpu"],
			],
			webPreferences: {
				backgroundThrottling: false,
				spellcheck: false,
				enableWebSQL: false,
				v8CacheOptions: "bypassHeatCheck",
			},
		});
	});

	test("allows a balanced GPU profile and a custom cache budget", () => {
		expect(
			getPerformanceProfile({
				OPENCUT_ELECTRON_GPU: "balanced",
				OPENCUT_ELECTRON_DISK_CACHE_BYTES: "1048576",
			}),
		).toMatchObject({
			commandLineSwitches: [["disk-cache-size", "1048576"]],
		});
	});

	test("adds one stable Electron runtime token to the user agent", () => {
		const userAgent = getElectronUserAgent("Chrome/140", "0.1.0");
		expect(userAgent).toBe("Chrome/140 OpenCutElectron/0.1.0");
		expect(getElectronUserAgent(userAgent, "0.1.0")).toBe(userAgent);
	});

	test("accepts a redirect from the local Next server", async () => {
		await expect(
			waitForHttp({
				url: getAppUrl(),
				timeoutMs: 100,
				request: async () => ({ status: 307 }),
				delay: async () => {},
			}),
		).resolves.toBeUndefined();
	});

	test("retries transient startup failures", async () => {
		let attempts = 0;
		await waitForHttp({
			url: getAppUrl(),
			timeoutMs: 100,
			request: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("connection refused");
				return { status: 200 };
			},
			delay: async () => {},
		});

		expect(attempts).toBe(2);
	});
});
