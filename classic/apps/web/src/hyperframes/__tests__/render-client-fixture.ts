/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test doubles implement the browser transport and bitmap boundary. */
import { expect, spyOn } from "bun:test";
import type { HyperframesComposition } from "../types";

export function composition(name = "main"): HyperframesComposition {
	return {
		source: {
			entryFile: "index.html",
			files: { "index.html": name },
			resourceAssetIds: { "image.png": "resource" },
		},
		compositionId: name,
		width: 64,
		height: 64,
		fps: 30,
		durationSeconds: 4,
	};
}

export function renderFixture({
	audio,
}: { audio?: { bytes: Uint8Array; artifact: () => unknown } } = {}) {
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const savedBitmap = Object.getOwnPropertyDescriptor(
		globalThis,
		"createImageBitmap",
	);
	const browser = Object.assign(new EventTarget(), {
		__opencutAccountId: "account-a",
		location: { origin: "http://127.0.0.1:3165" },
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browser,
	});
	const bitmaps: Array<{ width: number; height: number; closed: boolean }> = [];
	const dimensions = { width: 64, height: 64 };
	let decoded: (() => Promise<void>) | undefined;
	Object.defineProperty(globalThis, "createImageBitmap", {
		configurable: true,
		value: async () => {
			await decoded?.();
			const bitmap = {
				...dimensions,
				closed: false,
				close() {
					expect(this.closed).toBe(false);
					this.closed = true;
				},
			};
			bitmaps.push(bitmap);
			return bitmap;
		},
	});
	const live = new Set<string>();
	const captures = new Set<string>();
	const calls: Array<{
		action: string;
		projectId: string;
		id?: string;
		account: string | null;
	}> = [];
	let nextId = 0;
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		// eslint-disable-next-line opencut/prefer-object-params -- Browser fetch signature.
		(async (_url: RequestInfo | URL, options?: RequestInit) => {
			if (options?.method !== "POST")
				return new Response(Uint8Array.from(audio?.bytes ?? [1]));
			const input = JSON.parse(String(options.body)) as {
				action: string;
				projectId: string;
				id?: string;
			};
			calls.push({
				...input,
				account: new Headers(options.headers).get("X-OpenCut-Account"),
			});
			if (input.action === "open") {
				const id = String(++nextId);
				live.add(id);
				captures.add(id);
				expect(captures.size).toBeLessThanOrEqual(4);
				return Response.json({
					id,
					durationSeconds: 4,
					runtimeManifest: {
						sourceFingerprint: "fixture",
						runtimeVersion: "0.8.115",
						durationSeconds: 4,
						layers: [],
						diagnostics: [],
					},
				});
			}
			if (input.action === "close") {
				live.delete(input.id!);
				captures.delete(input.id!);
			}
			if (input.action === "capture") {
				captures.add(input.id!);
				expect(captures.size).toBeLessThanOrEqual(4);
			}
			if (input.action === "live") {
				captures.delete(input.id!);
				return Response.json({
					url: `http://${"a".repeat(48)}.localhost:1234/live-${input.id}.html`,
				});
			}
			if (input.action === "audio" && audio) {
				// The real host opens a disposable probe alongside warm captures.
				expect(captures.size).toBeLessThan(4);
				return Response.json(audio.artifact());
			}
			return Response.json({ id: "artifact" });
		}) as typeof fetch,
	);
	const draws: object[] = [];
	const target = {
		width: 64,
		height: 64,
		getContext: () => ({
			clearRect() {},
			drawImage(bitmap: { closed: boolean }) {
				expect(bitmap.closed).toBe(false);
				draws.push(bitmap);
			},
		}),
	} as unknown as OffscreenCanvas;
	return {
		browser,
		bitmaps,
		dimensions,
		live,
		captures,
		calls,
		draws,
		target,
		count: (action: string) =>
			calls.filter((call) => call.action === action).length,
		beforeDecode: (callback: () => Promise<void>) => {
			decoded = callback;
		},
		restore: () => {
			fetchMock.mockRestore();
			if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
			else Reflect.deleteProperty(globalThis, "window");
			if (savedBitmap)
				Object.defineProperty(globalThis, "createImageBitmap", savedBitmap);
			else Reflect.deleteProperty(globalThis, "createImageBitmap");
		},
	};
}
