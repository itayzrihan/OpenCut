import { expect, test } from "bun:test";
import { mockFetch } from "@/test-support/mock-fetch";
import {
	prepareClientAiPairing,
	selectLocalProvider,
	connectedProviderFetch,
	generateConnectedImage,
} from "../local-connection";

test("one native selection serves Agent and Director; exact account header and capability remain local", async () => {
	const original = {
		window: globalThis.window,
		sessionStorage: globalThis.sessionStorage,
		fetch: globalThis.fetch,
	};
	const values = new Map<string, string>();
	const events = new EventTarget();
	const win = {
		__opencutAccountId: "11111111-1111-4111-8111-111111111111",
		location: { origin: "https://pocut.example.test" },
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		dispatchEvent: events.dispatchEvent.bind(events),
	};
	Object.assign(globalThis, {
		window: win,
		sessionStorage: {
			getItem: (k: string) => values.get(k),
			setItem: (k: string, v: string) => values.set(k, v),
			removeItem: (k: string) => values.delete(k),
		},
	});
	const calls: Array<{
		url: string;
		headers: Headers;
		credentials: RequestCredentials | undefined;
	}> = [];
	globalThis.fetch = mockFetch(async (url, init) => {
		calls.push({
			url: String(url),
			headers: new Headers(init?.headers),
			credentials: init?.credentials,
		});
		return Response.json({ ok: true });
	});
	try {
		const pair = prepareClientAiPairing();
		selectLocalProvider("codex");
		for (const path of ["/api/editor-agent/respond", "/api/ai/chat"]) {
			const response = await connectedProviderFetch({
				path,
				init: { headers: { "x-opencut-account": "stale" } },
			});
			await response.json();
		}
		expect(
			calls.every((c) => c.url.startsWith("http://127.0.0.1:43127/")),
		).toBe(true);
		expect(
			calls.every(
				(c) =>
					c.headers.get("authorization") === `Bearer ${pair.token}` &&
					c.headers.get("x-opencut-account") === pair.accountId &&
					c.credentials === "omit",
			),
		).toBe(true);
		selectLocalProvider(null);
		await (await connectedProviderFetch({ path: "/api/ai/chat" })).json();
		expect(calls[2].url).toBe("/api/ai/chat");
		expect(calls[2].headers.get("authorization")).toBeNull();
		await expect(
			connectedProviderFetch({ path: "/api/local-drive" }),
		).rejects.toThrow("Unsupported");
	} finally {
		Object.assign(globalThis, original);
	}
});

test("provider changes cancel a streamed response after headers; native image requests do not silently use cloud", async () => {
	const original = {
		window: globalThis.window,
		sessionStorage: globalThis.sessionStorage,
		fetch: globalThis.fetch,
	};
	const values = new Map<string, string>();
	const events = new EventTarget();
	const win = {
		__opencutAccountId: "11111111-1111-4111-8111-111111111111",
		location: { origin: "https://pocut.example.test" },
		addEventListener: events.addEventListener.bind(events),
		removeEventListener: events.removeEventListener.bind(events),
		dispatchEvent: events.dispatchEvent.bind(events),
	};
	Object.assign(globalThis, {
		window: win,
		sessionStorage: {
			getItem: (k: string) => values.get(k),
			setItem: (k: string, v: string) => values.set(k, v),
			removeItem: (k: string) => values.delete(k),
		},
	});
	let output: ReadableStreamDefaultController<Uint8Array> | undefined;
	globalThis.fetch = mockFetch(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						output = c;
					},
				}),
			),
	);
	try {
		selectLocalProvider("codex");
		const response = await connectedProviderFetch({
			path: "/api/editor-agent/respond",
		});
		selectLocalProvider("claude");
		output?.enqueue(new TextEncoder().encode("stale result"));
		await expect(response.text()).rejects.toThrow();
		let called = 0;
		globalThis.fetch = mockFetch(async () => {
			called++;
			throw new TypeError("offline");
		});
		await expect(
			generateConnectedImage({
				projectId: "p",
				operationId: "image-1",
				prompt: "One image",
				confirmed: true,
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("companion");
		expect(called).toBe(1);
	} finally {
		Object.assign(globalThis, original);
	}
});
