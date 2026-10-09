import { afterAll, expect, test } from "bun:test";
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalFetch = globalThis.fetch;
afterAll(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
	globalThis.fetch = originalFetch;
});
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: {
		location: { origin: "http://localhost:3212", search: "" },
		__opencutAccountId: "account",
	},
});
const { previewProxySource, rejectPreviewProxy } = await import("../client");

test("only local account-scoped preview uses verified proxies; export, remote sources and account mismatches bypass them", async () => {
	let requests = 0;
	globalThis.fetch = Object.assign(
		async () => {
			requests++;
			return Response.json({ status: "ready", key: "verified" });
		},
		{ preconnect: originalFetch.preconnect },
	);
	const url =
		"/api/local-drive/media?projectId=project&id=media&account=account";
	expect(previewProxySource({ url })).toBeNull();
	expect(
		previewProxySource({
			url: "https://other.test/api/local-drive/media",
			maxSourceSize: 1280,
		}),
	).toBeNull();
	expect(
		previewProxySource({ url: `${url}2`, maxSourceSize: 1280 }),
	).toBeNull();
	expect(requests).toBe(0);
	expect(previewProxySource({ url, maxSourceSize: 1280 })).toBeNull();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(previewProxySource({ url, maxSourceSize: 1280 })?.key).toBe(
		"verified",
	);
	expect(previewProxySource({ url })).toBeNull();
	rejectPreviewProxy("verified");
	expect(previewProxySource({ url, maxSourceSize: 1280 })).toBeNull();
	expect(requests).toBe(1);
});
