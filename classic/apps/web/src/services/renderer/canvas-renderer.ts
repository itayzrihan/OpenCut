import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { scaleFrameOutput } from "./compositor/scale-frame-output";
import { compositorRenderQueue } from "./compositor/render-queue";
import { wasmCompositor } from "./compositor/wasm-compositor";
import type {
	FrameDescriptor,
	TextureUploadDescriptor,
} from "./compositor/types";
import { resolveRenderTree } from "./resolve";
import { initializeGpuRenderer } from "./gpu-renderer";
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
	private presentationCanvas: HTMLCanvasElement | null = null;

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
		return compositorRenderQueue.run(async () => {
			await initializeGpuRenderer();
			wasmCompositor.ensureInitialized({
				width: this.width,
				height: this.height,
			});
			return wasmCompositor.getCanvas();
		});
	}

	/** The GPU canvas is shared by preview, snapshots, thumbnails and exports.
	 * A mounted preview owns a separate canvas; only its renderer publishes to it. */
	async getPresentationCanvas(): Promise<HTMLCanvasElement> {
		this.presentationCanvas ??= document.createElement("canvas");
		return this.presentationCanvas;
	}

	private publishPresentation(canvas: HTMLCanvasElement) {
		const target = this.presentationCanvas;
		if (!target) return;
		if (target.width !== this.width) target.width = this.width;
		if (target.height !== this.height) target.height = this.height;
		const ctx = target.getContext("2d");
		if (!ctx) throw new Error("Failed to get preview presentation context");
		ctx.save();
		try {
			ctx.resetTransform();
			ctx.globalAlpha = 1;
			ctx.globalCompositeOperation = "copy";
			ctx.drawImage(canvas, 0, 0, target.width, target.height);
		} finally {
			ctx.restore();
		}
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
			consume: (canvas) => this.publishPresentation(canvas),
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
			// Thumbnails and background exports can run before EditorProvider has
			// finished starting the GPU. Every compositor consumer shares this wait.
			await initializeGpuRenderer();
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

			this.submitFrame(await this.prepareFrame({ node, time }));
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

	/** Render native layers on either side of a live DOM composition. Prepare
	 * both groups before touching the shared canvas, then copy the transparent
	 * foreground and restore the opaque base without yielding to browser paint. */
	async renderWithOverlay({
		node,
		overlay,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		overlay: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}): Promise<void> {
		return this.renderWithOverlays({
			node,
			time,
			overlays: [{ node: overlay, targetCanvas }],
		});
	}

	/** Prepare every native segment before synchronously publishing their
	 * transparent canvases and restoring the shared opaque base. */
	async renderWithOverlays({
		node,
		overlays,
		time,
	}: {
		node: AnyBaseNode;
		overlays: Array<{ node: AnyBaseNode; targetCanvas: HTMLCanvasElement }>;
		time: number;
	}): Promise<void> {
		const targets = overlays.map(({ node, targetCanvas }) => {
			const ctx = targetCanvas.getContext("2d");
			if (!ctx) throw new Error("Failed to get overlay canvas context");
			return { node, targetCanvas, ctx };
		});
		await compositorRenderQueue.run(async () => {
			await initializeGpuRenderer();
			const base = await this.prepareFrame({ node, time });
			const foregrounds = [];
			for (const [index, target] of targets.entries()) {
				const foreground = await this.prepareFrame({
					node: target.node,
					time,
					rootPath: index === 0 ? "root:overlay" : `root:overlay:${index}`,
				});
				foreground.frame = {
					...foreground.frame,
					clear: { color: [0, 0, 0, 0] },
				};
				foregrounds.push({ ...foreground, ...target });
			}
			this.staticSceneNode = null;
			this.staticSceneRendered = false;
			this.staticSceneGeneration = null;
			// Keep every group's textures resident with distinct IDs. Separate
			// syncTextures calls would evict and re-upload each group per frame.
			this.syncFrameTextures([
				...base.textures,
				...foregrounds.flatMap((group) => group.textures),
			]);
			try {
				for (const { frame, ctx, targetCanvas } of foregrounds) {
					this.renderFrame(frame);
					ctx.save();
					try {
						ctx.resetTransform();
						ctx.globalAlpha = 1;
						// Replace transparent pixels too, so moving or ending clips
						// cannot leave old content behind in the presentation canvas.
						ctx.globalCompositeOperation = "copy";
						ctx.drawImage(
							wasmCompositor.getCanvas(),
							0,
							0,
							targetCanvas.width,
							targetCanvas.height,
						);
					} finally {
						ctx.restore();
					}
				}
			} finally {
				this.renderFrame(base.frame);
				this.publishPresentation(wasmCompositor.getCanvas());
			}
			onRenderPerfFrameComplete();
		});
	}

	private async prepareFrame({
		node,
		time,
		rootPath,
	}: {
		node: AnyBaseNode;
		time: number;
		rootPath?: string;
	}) {
		const logicalRenderer = {
			width: this.logicalWidth,
			height: this.logicalHeight,
		};
		await measureSpanAsync({
			name: "resolve",
			fn: () =>
				resolveRenderTree({
					node,
					renderer: logicalRenderer,
					time,
					outputSize: { width: this.width, height: this.height },
				}),
		});
		const logicalFrame = await measureSpanAsync({
			name: "buildFrame",
			fn: () =>
				buildFrameDescriptor({ node, renderer: logicalRenderer, rootPath }),
		});
		return measureSpanSync({
			name: "scalePreviewFrame",
			fn: () =>
				scaleFrameOutput({
					...logicalFrame,
					width: this.width,
					height: this.height,
				}),
		});
	}

	private submitFrame({
		frame,
		textures,
	}: Awaited<ReturnType<CanvasRenderer["prepareFrame"]>>) {
		this.syncFrameTextures(textures);
		this.renderFrame(frame);
	}

	private syncFrameTextures(textures: TextureUploadDescriptor[]) {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
	}

	private renderFrame(frame: FrameDescriptor) {
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
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
