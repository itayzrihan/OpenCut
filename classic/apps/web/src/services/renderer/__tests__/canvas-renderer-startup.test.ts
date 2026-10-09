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
	renderFrame: (value: FrameDescriptor) =>
		events.push(value.clear.color[3] === 0 ? "transparent-render" : "render"),
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
	const { initializeGpuRenderer, isGpuAvailable } =
		await import("../gpu-renderer");
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

test("native overlay preparation precedes an uninterrupted transparent copy and opaque base restore", async () => {
	const { CanvasRenderer } = await import("../canvas-renderer");
	const renderer = new CanvasRenderer({
		width: 640,
		height: 360,
		fps: { numerator: 30, denominator: 1 },
	});
	const node = new BaseNode();
	let failCopy = false;
	const ctx = {
		globalAlpha: 0.2,
		globalCompositeOperation: "source-over",
		save() {},
		resetTransform() {},
		restore() {},
		drawImage(canvas: HTMLCanvasElement) {
			expect(canvas).toBe(outputCanvas);
			expect(this.globalAlpha).toBe(1);
			expect(this.globalCompositeOperation).toBe("copy");
			events.push("overlay-copy");
			if (failCopy) throw new Error("Copy failed");
		},
	};
	const targetCanvas = {
		width: 640,
		height: 360,
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	const render = () =>
		renderer.renderWithOverlay({
			node,
			overlay: new BaseNode(),
			time: 0,
			targetCanvas,
		});
	events.length = 0;
	await Promise.all([
		render(),
		renderer.renderAndConsume({
			node,
			time: 0,
			consume: () => events.push("other-consumer"),
		}),
	]);
	expect(events).toEqual([
		"resolve",
		"resolve",
		"transparent-render",
		"overlay-copy",
		"render",
		"resolve",
		"render",
		"other-consumer",
	]);
	expect(frame.clear.color).toEqual([0, 0, 0, 1]);
	failCopy = true;
	events.length = 0;
	await expect(render()).rejects.toThrow("Copy failed");
	expect(events).toEqual([
		"resolve",
		"resolve",
		"transparent-render",
		"overlay-copy",
		"render",
	]);
	failCopy = false;
	events.length = 0;
	await renderer.renderWithOverlays({
		node,
		time: 0,
		overlays: [
			{ node: new BaseNode(), targetCanvas },
			{
				node: new BaseNode(),
				targetCanvas: { ...targetCanvas } as HTMLCanvasElement,
			},
		],
	});
	expect(events).toEqual([
		"resolve",
		"resolve",
		"resolve",
		"transparent-render",
		"overlay-copy",
		"transparent-render",
		"overlay-copy",
		"render",
	]);
});

test("background review renders cannot replace or resize the mounted preview, including failed captures", async () => {
	const { CanvasRenderer } = await import("../canvas-renderer");
	const originalDocument = globalThis.document;
	let copies = 0;
	const ctx = {
		globalAlpha: 0.2,
		globalCompositeOperation: "source-over",
		save() {},
		resetTransform() {},
		restore() {},
		drawImage(canvas: HTMLCanvasElement) {
			expect(canvas).toBe(outputCanvas);
			expect(this.globalAlpha).toBe(1);
			expect(this.globalCompositeOperation).toBe("copy");
			copies++;
		},
	};
	const visible = {
		width: 0,
		height: 0,
		getContext: () => ctx,
	} as unknown as HTMLCanvasElement;
	globalThis.document = { createElement: () => visible } as unknown as Document;
	try {
		const preview = new CanvasRenderer({
			width: 640,
			height: 360,
			fps: { numerator: 30, denominator: 1 },
		});
		const review = new CanvasRenderer({
			width: 1536,
			height: 1024,
			fps: { numerator: 30, denominator: 1 },
		});
		expect(await preview.getPresentationCanvas()).toBe(visible);
		expect(visible).not.toBe(await review.getOutputCanvas());
		const node = new BaseNode();
		await preview.render({ node, time: 0 });
		expect(copies).toBe(1);
		expect([visible.width, visible.height]).toEqual([640, 360]);
		await review.renderAndConsume({ node, time: 360000, consume: () => {} });
		await expect(
			review.renderAndConsume({
				node,
				time: 480000,
				consume: () => {
					throw new Error("Capture cancelled");
				},
			}),
		).rejects.toThrow("Capture cancelled");
		expect(copies).toBe(1);
		expect([visible.width, visible.height]).toEqual([640, 360]);
		await preview.renderWithOverlays({ node, overlays: [], time: 4000 });
		expect(copies).toBe(2);
		// Same-renderer snapshots also do not publish. The next real preview may
		// safely render after the shared compositor was used by another consumer.
		await preview.renderAndConsume({ node, time: 720000, consume: () => {} });
		expect(copies).toBe(2);
		await preview.render({ node, time: 8000 });
		expect(copies).toBe(3);
	} finally {
		globalThis.document = originalDocument;
	}
});
