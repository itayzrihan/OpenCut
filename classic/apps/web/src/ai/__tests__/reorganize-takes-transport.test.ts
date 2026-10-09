import { afterEach, expect, test } from "bun:test";
import { mockFetch } from "@/test-support/mock-fetch";
import { requestReorganizeTakesPlan } from "../reorganize-takes-plan";
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
afterEach(() => {
	globalThis.fetch = originalFetch;
	globalThis.window = originalWindow;
});
function setup() {
	const events = new EventTarget();
	const win = {
		__opencutAccountId: "alice",
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	};
	Object.assign(globalThis, { window: win });
	return win;
}
const phrases = [
	{ id: "a", text: "First take", startTime: 0, endTime: 2 },
	{ id: "b", text: "Second take", startTime: 3, endTime: 5 },
];
const plan = {
	order: ["b", "a"],
	cut: [],
	takeClusters: [{ ids: ["a", "b"] }],
};
test("uses the current ChatGPT connection and only accepts a completed structured response", async () => {
	setup();
	const requests: Array<{ path: string; init?: RequestInit }> = [];
	globalThis.fetch = mockFetch(async (url, init) => {
		requests.push({ path: String(url), init });
		if (String(url).endsWith("connection"))
			return Response.json({ models: [{ id: "connected-model" }] });
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], output_text: JSON.stringify(plan) } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	expect(await requestReorganizeTakesPlan({ phrases })).toEqual(plan);
	expect(requests.map((x) => x.path)).toEqual([
		"/api/editor-agent/connection",
		"/api/editor-agent/respond",
	]);
	const body = JSON.parse(String(requests[1].init?.body));
	expect(body.model).toBe("connected-model");
	expect(body.tools).toEqual([]);
	expect(new Headers(requests[1].init?.headers).get("X-OpenCut-Account")).toBe(
		"alice",
	);
});
test("does not request a plan when model discovery fails", async () => {
	setup();
	let count = 0;
	globalThis.fetch = mockFetch(async () => {
		count++;
		return Response.json({ error: "Connect ChatGPT" }, { status: 401 });
	});
	await expect(requestReorganizeTakesPlan({ phrases })).rejects.toThrow(
		"Connect ChatGPT",
	);
	expect(count).toBe(1);
});
test("discards a plan if the active account changes", async () => {
	const win = setup();
	globalThis.fetch = mockFetch(async (url) => {
		if (String(url).endsWith("connection"))
			return Response.json({ models: [{ id: "model" }] });
		win.__opencutAccountId = "bob";
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], output_text: JSON.stringify(plan) } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	await expect(requestReorganizeTakesPlan({ phrases })).rejects.toThrow(
		"Account changed",
	);
});
