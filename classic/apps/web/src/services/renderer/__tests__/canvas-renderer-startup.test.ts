/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canvas stand-ins exercise startup ordering without a browser GPU. */
import { expect, mock, spyOn, test } from "bun:test";
import type { FrameDescriptor } from "../compositor/types";
import { BaseNode } from "../nodes/base-node";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const started = deferred();
const ready = deferred();
let attempts = 0;
let initialized = false;
const events: string[] = [];
const outputCanvas = {} as HTMLCanvasElement;
const frame: FrameDescriptor = {
	width: 640,
	height: 360,
	clear: { color: [0, 0, 0, 1] },
	items: [],
};

mock.module("opencut-wasm", () => ({
	initializeGpu: async () => {
		attempts++;
		if (attempts === 1) throw new Error("GPU adapter temporarily unavailable");
		started.resolve();
		await ready.promise;
		initialized = true;
		events.push("gpu-ready");
	},
	initCompositor: () => {
		if (!initialized) throw new Error("GPU context not initialized");
		events.push("compositor-ready");
	},
	getCompositorCanvas: () => outputCanvas,
	getLastFrameProfile: () => [],
	releaseTexture: () => {},
	renderFrame: () => events.push("render"),
	resizeCompositor: () => {},
	uploadTexture: () => {},
	applyEffectPasses: () => {},
	applyMaskFeather: () => {},
}));
mock.module("../canvas-utils", () => ({
	createCanvasSurface: () => ({ canvas: {}, context: {} }),
}));
mock.module("../resolve", () => ({
	resolveRenderTree: async () => events.push("resolve"),
}));
mock.module("../compositor/frame-descriptor", () => ({
	buildFrameDescriptor: async () => ({ frame, textures: [] }),
}));
mock.module("../static-node-cache", () => ({
	isStaticRenderTree: () => false,
}));

test("thumbnail and preview wait for shared GPU startup, including recovery after failure", async () => {
	const { CanvasRenderer } = await import("../canvas-renderer");
	const { initializeGpuRenderer, isGpuAvailable } = await import("../gpu-renderer");
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const renderer = new CanvasRenderer({
			width: 640,
			height: 360,
			fps: { numerator: 30, denominator: 1 },
		});
		const node = new BaseNode();
		await expect(renderer.render({ node, time: 0 })).rejects.toThrow(
			"GPU context not initialized",
		);
		expect(attempts).toBe(1);
		expect(isGpuAvailable()).toBe(false);
		expect(events).not.toContain("render");

		events.length = 0;
		// EditorProvider starts loading the project and GPU concurrently. A
		// thumbnail can be requested while that same GPU promise is pending.
		const providerStartup = initializeGpuRenderer();
		const thumbnail = renderer.renderAndConsume({
			node,
			time: 0,
			consume: (canvas) => {
				expect(canvas).toBe(outputCanvas);
				events.push("thumbnail");
			},
		});
		const previewCanvas = renderer.getOutputCanvas();
		await started.promise;
		await Promise.resolve();
		expect(attempts).toBe(2);
		expect(events).toEqual([]);
		expect(isGpuAvailable()).toBe(false);

		ready.resolve();
		await Promise.all([providerStartup, thumbnail]);
		expect(await previewCanvas).toBe(outputCanvas);
		expect(isGpuAvailable()).toBe(true);
		expect(events).toEqual([
			"gpu-ready",
			"resolve",
			"compositor-ready",
			"render",
			"thumbnail",
		]);
		await renderer.render({ node, time: 4_000 });
		expect(attempts).toBe(2);
		expect(events.at(-1)).toBe("render");
	} finally {
		warning.mockRestore();
	}
});
