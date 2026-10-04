/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser transport and bitmap decoding are platform test doubles. */
import { expect, spyOn, test } from "bun:test";
import { HyperframesRenderClient } from "../render-client";
import type { HyperframesComposition } from "../types";
import { composition, renderFixture } from "./render-client-fixture";

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
		value: async () => ({ width: 64, height: 64, close: () => bitmapCloses++ }),
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
	const draw = ({
		name,
		timeSeconds = 1,
	}: {
		name: string;
		timeSeconds?: number;
	}) =>
		client.renderTo({ composition: composition(name), timeSeconds, target });
	try {
		const [ready, reused] = await Promise.all([
			client.prepareSource(composition("a").source),
			client.prepareSource(composition("a").source),
		]);
		expect(ready).toMatchObject({ id: "1", durationSeconds: 4 });
		expect(reused).toEqual(ready);
		expect(nextId).toBe(1);
		await Promise.all([
			draw({ name: "a" }),
			draw({ name: "b" }),
			draw({ name: "a" }),
			draw({ name: "c" }),
		]);
		expect(nextId).toBe(3);
		expect(live.size).toBe(2);
		expect(bitmapCloses).toBe(0);
		expect(calls).toEqual([
			"open",
			"capture",
			"open",
			"capture",
			"close",
			"open",
			"capture",
		]);
		failCapture = true;
		await expect(draw({ name: "c", timeSeconds: 2 })).rejects.toThrow(
			"Session expired",
		);
		await draw({ name: "c", timeSeconds: 2 });
		expect(nextId).toBe(4);
		client.dispose();
		await expect(
			client.prepareSource(composition("a").source),
		).rejects.toThrow();
		await expect(draw({ name: "c" })).rejects.toThrow();
		await Promise.resolve();
		expect(live.size).toBe(0);
		expect(bitmapCloses).toBe(4);
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

test("independent occurrence leases retain four sources while captures use a bounded spare slot", async () => {
	const fixture = renderFixture();
	const client = new HyperframesRenderClient("project-a");
	try {
		const sources = ["one", "two", "three", "four"].map((name) =>
			composition(name),
		);
		const handles = [];
		for (const source of sources)
			handles.push(await client.openLivePreview({ composition: source }));
		expect(fixture.live.size).toBe(4);
		const duplicate = await client.openLivePreview({
			composition: composition("one"),
		});
		expect(duplicate.url).toBe(handles[0].url);
		expect(fixture.count("open")).toBe(4);
		const beforeMixed = fixture.calls.length;
		for (const source of sources) {
			await client.renderTo({
				composition: source,
				timeSeconds: 2,
				target: fixture.target,
			});
		}
		expect(
			fixture.calls.slice(beforeMixed).map((call) => [call.action, call.id]),
		).toEqual([
			["capture", "1"],
			["live", "1"],
			["capture", "2"],
			["live", "2"],
			["capture", "3"],
			["live", "3"],
			["capture", "4"],
		]);
		handles[0].release?.();
		handles[0].release?.();
		await expect(
			client.openLivePreview({ composition: composition("five") }),
		).rejects.toThrow("limit");
		for (const name of ["capture-a", "capture-b", "capture-c"]) {
			await client.renderTo({
				composition: composition(name),
				timeSeconds: 1,
				target: fixture.target,
			});
			expect(fixture.live.size).toBe(5);
			for (const id of ["1", "2", "3", "4"])
				expect(fixture.live.has(id)).toBe(true);
		}
		duplicate.release?.();
		const fifth = await client.openLivePreview({
			composition: composition("five"),
		});
		expect(fixture.live.has("1")).toBe(false);
		expect(fixture.live.size).toBeLessThanOrEqual(5);
		for (const handle of handles) handle.release?.();
		fifth.release?.();
		// Preparing an existing source drains release cleanup without a frame.
		await client.prepareSource(composition("five").source);
		expect(fixture.live.size).toBeLessThanOrEqual(2);
		client.dispose();
		await Promise.resolve();
		expect(fixture.live.size).toBe(0);
	} finally {
		client.dispose();
		fixture.restore();
	}
});
