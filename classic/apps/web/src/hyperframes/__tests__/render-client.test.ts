/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser transport and bitmap decoding are platform test doubles. */
import { expect, spyOn, test } from "bun:test";
import { HyperframesRenderClient } from "../render-client";
import type { HyperframesComposition } from "../types";

test("render cache bounds sessions, recovers closed captures and pins account/project", async () => {
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const savedBitmap = Object.getOwnPropertyDescriptor(
		globalThis,
		"createImageBitmap",
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "account-a" },
	});
	let bitmapCloses = 0;
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		value: async () => ({ close: () => bitmapCloses++ }),
	});
	const live = new Set<string>();
	let nextId = 0;
	let failCapture = false;
	const calls: string[] = [];
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		// eslint-disable-next-line opencut/prefer-object-params -- Fetch implements the browser's positional transport signature.
		(async (url: RequestInfo | URL, options?: RequestInit) => {
			expect(new Headers(options?.headers).get("X-OpenCut-Account")).toBe(
				"account-a",
			);
			if (options?.method !== "POST") {
				expect(String(url)).toContain("projectId=project-a");
				return new Response(new Uint8Array([1]));
			}
			const input = JSON.parse(String(options.body)) as {
				action: string;
				projectId: string;
				id?: string;
			};
			expect(input.projectId).toBe("project-a");
			calls.push(input.action);
			if (input.action === "open") {
				const id = String(++nextId);
				live.add(id);
				expect(live.size).toBeLessThanOrEqual(2);
				return Response.json({ id, durationSeconds: 4 });
			}
			if (input.action === "close") live.delete(input.id!);
			if (input.action === "capture" && failCapture) {
				failCapture = false;
				return Response.json({ error: "Session expired" }, { status: 400 });
			}
			return Response.json({ id: "artifact" });
		}) as typeof fetch,
	);
	const client = new HyperframesRenderClient("project-a");
	const target = {
		width: 64,
		height: 64,
		getContext: () => ({ clearRect() {}, drawImage() {} }),
	} as unknown as OffscreenCanvas;
	const composition = (name: string): HyperframesComposition => ({
		source: {
			entryFile: "index.html",
			files: { "index.html": name },
			resourceAssetIds: {},
		},
		compositionId: name,
		width: 64,
		height: 64,
		fps: 30,
		durationSeconds: 4,
	});
	const draw = (name: string) =>
		client.renderTo({ composition: composition(name), timeSeconds: 1, target });
	try {
		const [ready, reused] = await Promise.all([
			client.prepareSource(composition("a").source),
			client.prepareSource(composition("a").source),
		]);
		expect(ready).toMatchObject({ id: "1", durationSeconds: 4 });
		expect(reused).toEqual(ready);
		expect(nextId).toBe(1);
		await Promise.all([draw("a"), draw("b"), draw("a"), draw("c")]);
		expect(nextId).toBe(3);
		expect(live.size).toBe(2);
		expect(bitmapCloses).toBe(4);
		expect(calls).toEqual([
			"open",
			"capture",
			"open",
			"capture",
			"capture",
			"close",
			"open",
			"capture",
		]);
		failCapture = true;
		await expect(draw("c")).rejects.toThrow("Session expired");
		await draw("c");
		expect(nextId).toBe(4);
		client.dispose();
		await expect(
			client.prepareSource(composition("a").source),
		).rejects.toThrow();
		await expect(draw("c")).rejects.toThrow();
		await Promise.resolve();
		expect(live.size).toBe(0);
	} finally {
		client.dispose();
		fetchMock.mockRestore();
		if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (savedBitmap)
			Object.defineProperty(globalThis, "createImageBitmap", savedBitmap);
		else Reflect.deleteProperty(globalThis, "createImageBitmap");
	}
});
