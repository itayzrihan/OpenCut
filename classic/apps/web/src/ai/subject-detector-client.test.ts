import { mockFetch } from "@/test-support/mock-fetch";
import { afterEach, expect, test } from "bun:test";
import { requestSubjectDetections } from "./subject-detector-client";
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
const run = () =>
	requestSubjectDetections({
		frames: ["frame"],
		signal: new AbortController().signal,
	});
test("an uninstalled optional detector can use the recipe's existing fallback", async () => {
	globalThis.fetch = mockFetch(async () =>
		Response.json(
			{ error: "Detector not installed" },
			{ status: 503 },
		));
	expect(await run()).toEqual({
		available: false,
		error: "Detector not installed",
	});
});
test("authentication failures and server errors cannot silently become framing fallback", async () => {
	for (const status of [401, 403, 429, 500]) {
		globalThis.fetch = mockFetch(async () =>
			Response.json(
				{ error: `Rejected ${status}` },
				{ status },
			));
		await expect(run()).rejects.toThrow(`Rejected ${status}`);
	}
});
test("successful detector data passes unchanged to the Rust framing policy", async () => {
	const data = { frames: [{ faces: [], poses: [], width: 640, height: 360 }] };
	globalThis.fetch = mockFetch(async () => Response.json(data));
	expect(await run()).toEqual({ available: true, data });
});
