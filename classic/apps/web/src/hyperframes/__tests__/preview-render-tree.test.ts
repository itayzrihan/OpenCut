/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canvas identity is a platform double; timing uses the real WASM. */
import { beforeAll, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline/types";
import { mediaTime } from "@/wasm/media-time";
import type { HyperframesRenderContext } from "../types";

let buildScene: typeof import("@/services/renderer/scene-builder").buildScene;
let resolveRenderTree: typeof import("@/services/renderer/resolve").resolveRenderTree;
let liveModule: typeof import("../live-preview");
let GraphicNode: typeof import("@/services/renderer/nodes/graphic-node").GraphicNode;
let RootNode: typeof import("@/services/renderer/nodes/root-node").RootNode;

beforeAll(async () => {
	const glue = await import("../../../../../rust/wasm/pkg/opencut_wasm_bg.js");
	const bytes = await Bun.file(
		new URL(
			"../../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer();
	const { instance } = await WebAssembly.instantiate(bytes, {
		"./opencut_wasm_bg.js": glue,
	});
	glue.__wbg_set_wasm(instance.exports);
	const start = instance.exports.__wbindgen_start;
	if (typeof start !== "function")
		throw new Error("Missing WASM startup export");
	start();
	mock.module("opencut-wasm", () => glue);
	mock.module("@/services/renderer/canvas-utils", () => ({
		createCanvasSurface: ({
			width,
			height,
		}: {
			width: number;
			height: number;
		}) => ({
			canvas: { width, height } as OffscreenCanvas,
			context: {},
		}),
	}));
	({ buildScene } = await import("@/services/renderer/scene-builder"));
	({ resolveRenderTree } = await import("@/services/renderer/resolve"));
	liveModule = await import("../live-preview");
	({ GraphicNode } = await import("@/services/renderer/nodes/graphic-node"));
	({ RootNode } = await import("@/services/renderer/nodes/root-node"));
}, 15_000);

test("live preview preserves the authored viewport, source trim and layer order, and falls back after a runtime failure", async () => {
	const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const browser = new EventTarget();
	const frames: Array<HTMLIFrameElement> = [];
	const seeks: number[] = [];
	let failSeek = false;
	let openCount = 0;
	let fallbackCount = 0;
	let releaseCount = 0;
	const message = ({
		frame,
		data,
	}: {
		frame: HTMLIFrameElement;
		data: object;
	}) => {
		const event = new Event("message");
		Object.assign(event, {
			source: frame.contentWindow,
			data: { source: "opencut-hf-live", ...data },
		});
		browser.dispatchEvent(event);
	};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browser,
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => {
				const frame = {
					style: {},
					setAttribute() {},
					remove() {},
					contentWindow: {
						postMessage: (data: { sequence: number; timeSeconds: number }) => {
							seeks.push(data.timeSeconds);
							queueMicrotask(() =>
								message({
									frame,
									data: failSeek
										? { type: "error", message: "Unsupported canvas" }
										: { type: "frame", sequence: data.sequence },
								}),
							);
						},
					},
				} as unknown as HTMLIFrameElement;
				frames.push(frame);
				return frame;
			},
		},
	});
	const mount = {
		style: {},
		replaceChildren: (frame: HTMLIFrameElement) =>
			queueMicrotask(() => message({ frame, data: { type: "ready" } })),
	} as unknown as HTMLElement;
	const live = new liveModule.HyperframesLivePreview({
		mount,
		width: 640,
		height: 360,
		onFallback: () => fallbackCount++,
	});
	const sourceKey = {};
	const clip = new GraphicNode({
		definitionId: "hyperframes",
		params: {},
		isPreview: true,
		duration: 4 * 120000,
		timeOffset: 8 * 120000,
		trimStart: 120000,
		trimEnd: 120000,
		transform: {
			position: { x: 10, y: -20 },
			scaleX: -0.5,
			scaleY: 0.5,
			rotate: 15,
			perspectiveX: 0,
			perspectiveY: 0,
		},
		opacity: 0.75,
		frameSource: {
			width: 1080,
			height: 1920,
			getResourceRevision: () => 0,
			renderTo: async () => {
				throw new Error("Unexpected raster capture");
			},
			live: {
				key: sourceKey,
				open: async () => {
					openCount++;
					return {
						url: `http://${"a".repeat(48)}.localhost:1234/live.html`,
						release: () => {
							releaseCount++;
						},
					};
				},
				getSourceTime: (localTime) => (120000 + localTime) / 120000,
			},
		},
	});
	const root = new RootNode({ duration: 14 * 120000 });
	root.add(clip);
	const native = new GraphicNode({
		...clip.params,
		definitionId: "native-test",
		frameSource: undefined,
	});
	root.add(native);
	expect(
		liveModule.findHyperframesLiveLayer({ node: root, time: 9 * 120000 }),
	).toBeNull();
	root.remove(native);
	root.children.unshift(native);
	const rendered: (typeof root)[] = [];
	const renderer = {
		render: async ({ node }: { node: typeof root }) => {
			rendered.push(node);
		},
	} as unknown as import("@/services/renderer/canvas-renderer").CanvasRenderer;
	try {
		expect(
			liveModule.findHyperframesLiveLayer({ node: root, time: 7 * 120000 }),
		).toBeNull();
		expect(
			liveModule.findHyperframesLiveLayer({ node: root, time: 9 * 120000 }),
		).toBe(clip);
		await live.render({ node: root, time: 9 * 120000, renderer });
		expect(seeks).toEqual([2]);
		expect(root.children).toEqual([native, clip]);
		expect(rendered[0].children).toEqual([native]);
		expect(mount.style.visibility).toBe("visible");
		expect(frames[0].style).toMatchObject({
			width: "1080px",
			height: "1920px",
			left: "330px",
			top: "160px",
			opacity: "0.75",
			transform: "translate(-50%, -50%) rotate(15deg) scale(-0.09375, 0.09375)",
		});
		await live.render({ node: root, time: 10 * 120000, renderer });
		expect(openCount).toBe(1);
		expect(rendered[0]).toBe(rendered[1]);
		clip.params.transform.perspectiveX = 20;
		await live.render({ node: root, time: 10 * 120000, renderer });
		expect(rendered.at(-1)).toBe(root);
		expect(mount.style.visibility).toBe("hidden");
		expect(releaseCount).toBe(1);
		clip.params.transform.perspectiveX = 0;
		failSeek = true;
		await live.render({ node: root, time: 10 * 120000, renderer });
		expect(rendered.at(-1)).toBe(root);
		expect(fallbackCount).toBe(1);
		await live.render({ node: root, time: 11 * 120000, renderer });
		expect(seeks).toEqual([2, 3, 3]);
		expect(openCount).toBe(2);
		expect(releaseCount).toBe(2);
		clip.params.isPreview = false;
		expect(
			liveModule.findHyperframesLiveLayer({ node: root, time: 9 * 120000 }),
		).toBeNull();
	} finally {
		live.dispose();
		if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (savedDocument)
			Object.defineProperty(globalThis, "document", savedDocument);
		else Reflect.deleteProperty(globalThis, "document");
	}
});

test("the scene builder and resolver pass preview pixels while preserving trim, placement and export quality", async () => {
	const rendered: Array<{ timeSeconds: number; previewScale?: number }> = [];
	const hyperframes: HyperframesRenderContext = {
		compositions: {
			hf: {
				compositionId: "test",
				width: 1080,
				height: 1920,
				fps: 30,
				durationSeconds: 6,
				source: {
					entryFile: "index.html",
					files: { "index.html": "test" },
					resourceAssetIds: {},
				},
			},
		},
		getResourceRevision: () => 0,
		renderTo: async (input) => {
			rendered.push(input);
		},
	};
	const tracks: SceneTracks = {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			hidden: false,
			muted: false,
			elements: [],
		},
		audio: [],
		overlay: [
			{
				id: "hf-track",
				name: "HyperFrames",
				type: "graphic",
				hidden: false,
				elements: [
					{
						id: "clip",
						name: "Composition",
						type: "graphic",
						definitionId: "hyperframes",
						startTime: mediaTime({ ticks: 8 * 120000 }),
						duration: mediaTime({ ticks: 4 * 120000 }),
						trimStart: mediaTime({ ticks: 120000 }),
						trimEnd: mediaTime({ ticks: 120000 }),
						params: { hyperframesAssetId: "hf" },
					},
				],
			},
		],
	};
	const build = (isPreview: boolean) =>
		buildScene({
			tracks,
			hyperframes,
			isPreview,
			mediaAssets: [],
			duration: 14 * 120000,
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "transparent" },
		});
	const node = build(true);
	const resolve = ({
		outputWidth,
		target = node,
	}: {
		outputWidth: number;
		target?: typeof node;
	}) =>
		resolveRenderTree({
			node: target,
			renderer: { width: 1920, height: 1080 },
			outputSize: { width: outputWidth, height: (outputWidth * 9) / 16 },
			time: 9 * 120000,
		});
	await resolve({ outputWidth: 640 });
	await resolve({ outputWidth: 640 });
	await resolve({ outputWidth: 960 });
	await resolve({ outputWidth: 640, target: build(false) });
	expect(
		rendered.map(({ timeSeconds, previewScale }) => ({
			timeSeconds,
			previewScale,
		})),
	).toEqual([
		{ timeSeconds: 2, previewScale: 0.25 },
		{ timeSeconds: 2, previewScale: 0.5 },
		{ timeSeconds: 2, previewScale: 1 },
	]);
	await resolveRenderTree({
		node,
		renderer: { width: 1920, height: 1080 },
		time: 7 * 120000,
	});
	expect(rendered).toHaveLength(3);
	tracks.overlay[0].elements[0].params["transform.perspectiveX"] = 20;
	await resolve({ outputWidth: 640, target: build(true) });
	expect(rendered.at(-1)).toMatchObject({ timeSeconds: 2, previewScale: 1 });
});
