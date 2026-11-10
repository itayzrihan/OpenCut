import { mockFetch } from "@/test-support/mock-fetch";
import { expect, test } from "bun:test";
import { saveAgentModelPreference } from "@/editor-agent/model-preference";
import {
	aiClientFetch,
	prepareClientAiPairing,
	readClientAiPairing,
} from "../client-transport";

test("browser AI uses authenticated same-origin requests and discards responses after an account switch", async () => {
	const originalWindow = globalThis.window,
		originalStorage = globalThis.sessionStorage,
		originalFetch = globalThis.fetch;
	const saved = new Map<string, string>();
	const events = new EventTarget();
	const win = {
		__opencutAccountId: "alice",
		localStorage: {
			getItem: (key: string) => saved.get(key) ?? null,
			// eslint-disable-next-line opencut/prefer-object-params -- Browser Storage.setItem requires positional key and value arguments.
			setItem: (key: string, value: string) => saved.set(key, value),
		},
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
	const requests: Array<{ url: string; headers: Headers; body?: BodyInit | null }> = [];
	globalThis.fetch = mockFetch(async (input, init) => {
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: init?.body,
		});
		return Response.json({ identity: "alice" });
	});
	try {
		const alice = prepareClientAiPairing();
		saveAgentModelPreference({ model: "test/vision-selected", reasoningEffort: "high" });
		await aiClientFetch({ path: "/api/ai/chat", init: { method: "POST", body: "{}" } });
		expect(requests[0].url).toBe("/api/ai/chat");
		expect(requests[0].headers.get("authorization")).toBeNull();
		expect(requests[0].headers.get("x-opencut-account")).toBe("alice");
		expect(JSON.parse(String(requests[0].body))).toEqual({
			model: "test/vision-selected",
			reasoningEffort: "high",
		});
		win.__opencutAccountId = "bob";
		expect(readClientAiPairing()).toBeNull();
		await aiClientFetch({ path: "/api/ai/chat", init: { method: "POST", body: "{}" } });
		expect(requests[1].headers.get("x-opencut-account")).toBe("bob");
		expect(JSON.parse(String(requests[1].body))).toEqual({});
		const bob = prepareClientAiPairing();
		expect(bob.token).not.toBe(alice.token);
		globalThis.fetch = mockFetch(async () => {
			win.__opencutAccountId = "alice";
			return Response.json({ identity: "bob" });
		});
		await expect(aiClientFetch({ path: "/api/ai/oauth/status" })).rejects.toThrow(
			"Account changed",
		);
		globalThis.fetch = mockFetch(async () => {
			throw new TypeError("network unavailable");
		});
		await expect(aiClientFetch({ path: "/api/ai/chat" })).rejects.toThrow(
			"Could not reach POCUT",
		);
		expect(requests).toHaveLength(2);
		win.__opencutAccountId = "";
		await expect(aiClientFetch({ path: "/api/ai/chat" })).rejects.toThrow("Sign in");
	} finally {
		Object.assign(globalThis, {
			window: originalWindow,
			sessionStorage: originalStorage,
			fetch: originalFetch,
		});
	}
});
