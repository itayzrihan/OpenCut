import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import runtime from "../app/runtime.cjs";

const { getAppUrl, getPackagedServer, waitForHttp } = runtime;

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
