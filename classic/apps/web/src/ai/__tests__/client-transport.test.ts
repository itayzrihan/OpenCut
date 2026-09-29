import { expect, test } from "bun:test";
import {
	aiClientFetch,
	prepareClientAiPairing,
	readClientAiPairing,
} from "../client-transport";

test("remote AI stays on the client and discards responses after an account switch", async () => {
	const originalWindow = globalThis.window,
		originalStorage = globalThis.sessionStorage,
		originalFetch = globalThis.fetch;
	const saved = new Map<string, string>();
	const events = new EventTarget();
	const win = {
		__opencutAccountId: "alice",
		location: {
			origin: "https://editor.example.com",
			hostname: "editor.example.com",
		},
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
	};
	Object.assign(globalThis, {
		window: win,
		sessionStorage: {
			getItem: (k: string) => saved.get(k),
			setItem: (k: string, v: string) => saved.set(k, v),
			removeItem: (k: string) => saved.delete(k),
		},
	});
	const requests: Array<{ url: string; headers: Headers }> = [];
	globalThis.fetch = (async (input, init) => {
		requests.push({ url: String(input), headers: new Headers(init?.headers) });
		return Response.json({ identity: "alice" });
	}) as typeof fetch;
	try {
		await expect(aiClientFetch("/api/ai/chat")).rejects.toThrow(
			"Connect OpenCut AI",
		);
		expect(requests).toHaveLength(0);
		const alice = prepareClientAiPairing();
		await aiClientFetch("/api/ai/chat", { method: "POST", body: "{}" });
		expect(requests[0].url).toBe("http://127.0.0.1:43127/api/ai/chat");
		expect(requests[0].headers.get("authorization")).toBe(
			`Bearer ${alice.token}`,
		);
		expect(requests[0].headers.get("x-opencut-account")).toBe("alice");
		win.__opencutAccountId = "bob";
		expect(readClientAiPairing()).toBeNull();
		await expect(aiClientFetch("/api/ai/chat")).rejects.toThrow(
			"Connect OpenCut AI",
		);
		const bob = prepareClientAiPairing();
		expect(bob.token).not.toBe(alice.token);
		globalThis.fetch = (async () => {
			win.__opencutAccountId = "alice";
			return Response.json({ identity: "bob" });
		}) as typeof fetch;
		await expect(aiClientFetch("/api/ai/oauth/status")).rejects.toThrow(
			"Account changed",
		);
		globalThis.fetch = (async () => {
			throw new TypeError("network unavailable");
		}) as typeof fetch;
		await expect(aiClientFetch("/api/ai/chat")).rejects.toThrow(
			"not reachable",
		);
		expect(requests).toHaveLength(1); // No retry against the hosting server.
	} finally {
		Object.assign(globalThis, {
			window: originalWindow,
			sessionStorage: originalStorage,
			fetch: originalFetch,
		});
	}
});
