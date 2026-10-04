/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Canvas identity is a platform double; timing uses the real WASM. */
import { beforeAll, expect, mock, test } from "bun:test";
import type { SceneTracks } from "@/timeline/types";
import { mediaTime } from "@/wasm/media-time";
import type { HyperframesRenderContext } from "../types";

let buildScene: typeof import("@/services/renderer/scene-builder").buildScene;
let resolveRenderTree: typeof import("@/services/renderer/resolve").resolveRenderTree;

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
