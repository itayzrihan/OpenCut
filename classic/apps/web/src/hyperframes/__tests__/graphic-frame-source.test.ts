/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- A canvas identity double exercises cache invalidation without requiring a browser GPU. */
import { expect, mock, test } from "bun:test";
import { getCanvasSourceVersion } from "@/services/renderer/canvas-source-version";

mock.module("@/graphics", () => ({
	registerDefaultGraphics: () => {},
	getGraphicDefinition: () => {
		throw new Error("Unexpected procedural render");
	},
	getGraphicLayoutSize: () => null,
	DEFAULT_GRAPHIC_SOURCE_SIZE: 512,
}));
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
const { GraphicNode } = await import("@/services/renderer/nodes/graphic-node");

test("external frames refresh GPU textures on seek and resource replacement", async () => {
	let revision = 0;
	let fail = false;
	const draws: number[] = [];
	const scales: number[] = [];
	const node = new GraphicNode({
		definitionId: "hyperframes",
		isPreview: true,
		params: {},
		duration: 360000,
		timeOffset: 0,
		trimStart: 120000,
		trimEnd: 0,
		opacity: 0.5,
		transform: {
			scaleX: 1,
			scaleY: 1,
			position: { x: 0, y: 0 },
			rotate: 0,
			perspectiveX: 0,
			perspectiveY: 0,
		},
		frameSource: {
			width: 640,
			height: 360,
			getResourceRevision: () => revision,
			renderTo: async ({ localTime, previewScale }) => {
				if (fail) throw new Error("Capture failed");
				draws.push(localTime);
				scales.push(previewScale);
			},
		},
	});
	const read = (localTime: number) =>
		node.getSource({ resolvedParams: {}, localTime });
	expect(() => read(0)).toThrow("not prepared");
	await node.prepareFrame({ localTime: 0 });
	const canvas = read(0);
	const firstVersion = getCanvasSourceVersion({ source: canvas });
	expect(firstVersion).toBeDefined();
	await node.prepareFrame({ localTime: 0 });
	expect(draws).toEqual([0]);
	await node.prepareFrame({ localTime: 240000 });
	expect(read(240000)).toBe(canvas);
	expect(getCanvasSourceVersion({ source: canvas })).not.toBe(firstVersion);
	expect(() => read(0)).toThrow("not prepared");
	const laterVersion = getCanvasSourceVersion({ source: canvas });
	revision++;
	expect(() => read(240000)).toThrow("not prepared");
	await node.prepareFrame({ localTime: 240000 });
	expect(getCanvasSourceVersion({ source: canvas })).not.toBe(laterVersion);
	expect(draws).toEqual([0, 240000, 240000]);
	fail = true;
	await expect(node.prepareFrame({ localTime: 120000 })).rejects.toThrow(
		"Capture failed",
	);
	expect(() => read(120000)).toThrow("not prepared");
	fail = false;
	await node.prepareFrame({ localTime: 0 });
	expect(read(0)).toBe(canvas);
	const fullVersion = getCanvasSourceVersion({ source: canvas });
	await node.prepareFrame({ localTime: 0, previewScale: 0.5 });
	expect(getCanvasSourceVersion({ source: canvas })).not.toBe(fullVersion);
	await node.prepareFrame({ localTime: 0, previewScale: 0.5 });
	expect(scales).toEqual([1, 1, 1, 1, 0.5]);
	expect(node.getSourceSize()).toEqual({ width: 640, height: 360 });
	node.params.isPreview = false;
	await node.prepareFrame({ localTime: 0, previewScale: 0.25 });
	expect(scales.at(-1)).toBe(1);
	expect(getCanvasSourceVersion({ source: canvas })).toBe(fullVersion);
});
