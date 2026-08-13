import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { scaleFrameOutput } from "./compositor/scale-frame-output";
import { compositorRenderQueue } from "./compositor/render-queue";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import { isStaticRenderTree } from "./static-node-cache";
import {
	incrementCounter,
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	logicalWidth?: number;
	logicalHeight?: number;
	fps: FrameRate;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	logicalWidth: number;
	logicalHeight: number;
	fps: FrameRate;
	private staticSceneNode: AnyBaseNode | null = null;
	private staticSceneRendered = false;
	private staticSceneGeneration: number | null = null;

	constructor({
		width,
		height,
		logicalWidth = width,
		logicalHeight = height,
		fps,
	}: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.logicalWidth = logicalWidth;
		this.logicalHeight = logicalHeight;
		this.fps = fps;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async getOutputCanvas(): Promise<HTMLCanvasElement> {
		return compositorRenderQueue.run(() => {
			wasmCompositor.ensureInitialized({
				width: this.width,
				height: this.height,
			});
			return wasmCompositor.getCanvas();
		});
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;
		this.staticSceneNode = null;
		this.staticSceneRendered = false;
		this.staticSceneGeneration = null;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	async render({
		node,
		time,
		completePerfFrame = true,
	}: {
		node: AnyBaseNode;
		time: number;
		completePerfFrame?: boolean;
	}) {
		await this.renderAndConsume({
			node,
			time,
			completePerfFrame,
			consume: () => undefined,
		});
	}

	async renderAndConsume<T>({
		node,
		time,
		consume,
		completePerfFrame = true,
	}: {
		node: AnyBaseNode;
		time: number;
		consume: (canvas: HTMLCanvasElement) => Promise<T> | T;
		completePerfFrame?: boolean;
	}): Promise<T> {
		return compositorRenderQueue.run(async () => {
			const staticScene = isStaticRenderTree(node);
			if (
				staticScene &&
				this.staticSceneNode === node &&
				this.staticSceneRendered &&
				this.staticSceneGeneration === wasmCompositor.getGeneration()
			) {
				incrementCounter({ name: "renderCache.staticSceneHit" });
				const cachedResult = await consume(wasmCompositor.getCanvas());
				if (completePerfFrame) {
					onRenderPerfFrameComplete();
				}
				return cachedResult;
			}

			const logicalRenderer = {
				width: this.logicalWidth,
				height: this.logicalHeight,
			};
			await measureSpanAsync({
				name: "resolve",
				fn: () => resolveRenderTree({ node, renderer: logicalRenderer, time }),
			});
			const logicalFrame = await measureSpanAsync({
				name: "buildFrame",
				fn: () => buildFrameDescriptor({ node, renderer: logicalRenderer }),
			});
			const { frame, textures } = measureSpanSync({
				name: "scalePreviewFrame",
				fn: () =>
					scaleFrameOutput({
						...logicalFrame,
						width: this.width,
						height: this.height,
					}),
			});
			wasmCompositor.ensureInitialized({
				width: this.width,
				height: this.height,
			});
			measureSpanSync({
				name: "syncTextures",
				fn: () => wasmCompositor.syncTextures(textures),
			});
			measureSpanSync({
				name: "renderFrame",
				fn: () => wasmCompositor.render(frame),
			});
			this.staticSceneNode = staticScene ? node : null;
			this.staticSceneRendered = staticScene;
			this.staticSceneGeneration = staticScene
				? wasmCompositor.getGeneration()
				: null;
			const result = await consume(wasmCompositor.getCanvas());
			if (completePerfFrame) {
				onRenderPerfFrameComplete();
			}
			return result;
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		await this.renderAndConsume({
			node,
			time,
			consume: (outputCanvas) => {
				measureSpanSync({
					name: "drawImage",
					fn: () =>
						ctx.drawImage(
							outputCanvas,
							0,
							0,
							targetCanvas.width,
							targetCanvas.height,
						),
				});
			},
		});
	}
}
