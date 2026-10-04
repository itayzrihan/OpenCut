import type { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { computeVisualTransform } from "@/services/renderer/compositor/frame-descriptor";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { VisualNode } from "@/services/renderer/nodes/visual-node";
import { TextNode } from "@/services/renderer/nodes/text-node";
import { resolveGraphicNodeLayout } from "@/services/renderer/resolve";
import { incrementCounter } from "@/diagnostics/render-perf";

/** Native source-over layers can be isolated above a live composition. Effects
 * on the whole scene and blend modes that read the backdrop require capture. */
export function findHyperframesLiveLayer({
	node,
	time,
}: {
	node: RootNode;
	time: number;
}): GraphicNode | null {
	for (const child of [...node.children].reverse()) {
		if (child instanceof VisualNode || child instanceof TextNode) {
			const start =
				child instanceof TextNode
					? child.params.startTime
					: child.params.timeOffset;
			if (time < start || time >= start + child.params.duration) continue;
		}
		if (
			child instanceof GraphicNode &&
			child.params.definitionId === "hyperframes" &&
			child.params.isPreview &&
			child.params.frameSource?.live &&
			!child.params.effects?.length &&
			!child.params.masks?.length &&
			(!child.params.blendMode || child.params.blendMode === "normal") &&
			child.children.length === 0
		)
			return child;
		if (
			(child instanceof VisualNode || child instanceof TextNode) &&
			!(
				child instanceof GraphicNode &&
				child.params.definitionId === "hyperframes"
			) &&
			(!child.params.blendMode || child.params.blendMode === "normal") &&
			child.children.length === 0
		)
			continue;
		return null;
	}
	return null;
}

type Surface = {
	url: string;
	frame: HTMLIFrameElement;
	ready: Promise<void>;
	readyResolve: () => void;
	readyReject: (error: Error) => void;
	readyTimer: ReturnType<typeof setTimeout>;
	sequence: number;
	waiting?: {
		sequence: number;
		resolve: () => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	};
	failed: boolean;
};

/** Derived browser rendering resources only; time and layout come from the
 * existing render tree on every frame. No separate player or editor state. */
export class HyperframesLivePreview {
	private surface: Surface | null = null;
	private sourceKey: object | null = null;
	private sourceRevision = -1;
	private releaseSource: (() => void) | null = null;
	private readonly failedSources = new WeakMap<object, number>();
	private readonly failedUrls = new Set<string>();
	private overlayCanvas: HTMLCanvasElement | null = null;
	private baseTree: {
		original: RootNode;
		omitted: GraphicNode;
		tree: RootNode;
		overlay: RootNode;
	} | null = null;
	private disposed = false;

	constructor(
		private readonly options: {
			mount: HTMLElement;
			width: number;
			height: number;
			onFallback: () => void;
		},
	) {
		window.addEventListener("message", this.onMessage);
		Object.assign(options.mount.style, { visibility: "hidden" });
	}

	async render({
		node,
		time,
		renderer,
	}: {
		node: RootNode;
		time: number;
		renderer: CanvasRenderer;
	}): Promise<void> {
		const candidate = findHyperframesLiveLayer({ node, time });
		const resolved = candidate
			? resolveGraphicNodeLayout({
					node: candidate,
					renderer: this.options,
					time,
				})
			: null;
		let live = false;
		if (
			candidate &&
			resolved &&
			resolved.effectPasses.length === 0 &&
			resolved.transform.perspectiveX === 0 &&
			resolved.transform.perspectiveY === 0
		) {
			const source = candidate.params.frameSource!;
			const revision = source.getResourceRevision();
			if (this.failedSources.get(source.live!.key) !== revision) {
				try {
					await this.prepareSurface({ source, revision });
					await this.seek(source.live!.getSourceTime(resolved.localTime));
					if (source.getResourceRevision() !== revision)
						throw new Error("Live preview resources changed");
					live = !this.disposed;
				} catch (error) {
					this.failedSources.set(source.live!.key, revision);
					this.hide();
					if (!this.disposed)
						console.info(
							"HyperFrames live preview is using capture:",
							error instanceof Error ? error.message : "Preview unavailable",
						);
					incrementCounter({ name: "preview.hyperframesLiveFallback" });
				}
			}
		}
		if (this.disposed) return;
		if (!live || !candidate || !resolved) {
			this.removeSurface();
			await renderer.render({ node, time });
			return;
		}
		if (
			this.baseTree?.original !== node ||
			this.baseTree.omitted !== candidate
		) {
			const index = node.children.indexOf(candidate);
			const tree = new RootNode(node.params);
			tree.children = node.children.slice(0, index);
			const overlay = new RootNode(node.params);
			overlay.children = node.children.slice(index + 1);
			this.baseTree = { original: node, omitted: candidate, tree, overlay };
		}
		try {
			if (this.baseTree.overlay.children.length) {
				if (!this.overlayCanvas) {
					this.overlayCanvas = document.createElement("canvas");
					this.overlayCanvas.setAttribute("aria-hidden", "true");
					Object.assign(this.overlayCanvas.style, {
						position: "absolute",
						inset: "0",
						pointerEvents: "none",
						width: `${this.options.width}px`,
						height: `${this.options.height}px`,
					});
				}
				const canvas = this.overlayCanvas;
				if (canvas.width !== renderer.width) canvas.width = renderer.width;
				if (canvas.height !== renderer.height) canvas.height = renderer.height;
				if (canvas.parentElement !== this.options.mount)
					this.options.mount.appendChild(canvas);
				await renderer.renderWithOverlay({
					node: this.baseTree.tree,
					overlay: this.baseTree.overlay,
					time,
					targetCanvas: canvas,
				});
			} else {
				this.removeOverlay();
				await renderer.render({ node: this.baseTree.tree, time });
			}
		} catch (error) {
			this.hide();
			throw error;
		}
		if (this.disposed || !this.surface || this.surface.failed) return;
		const quad = computeVisualTransform({
			renderer: this.options,
			resolved,
			sourceWidth: resolved.sourceWidth,
			sourceHeight: resolved.sourceHeight,
			cameraWidth: candidate.params.cameraCanvasWidth,
			cameraHeight: candidate.params.cameraCanvasHeight,
			fitMode: "contain",
		});
		// Preserve the authored viewport; scale its pixels as the canvas does.
		Object.assign(this.surface.frame.style, {
			width: `${resolved.sourceWidth}px`,
			height: `${resolved.sourceHeight}px`,
			left: `${quad.centerX}px`,
			top: `${quad.centerY}px`,
			opacity: String(resolved.opacity),
			transform: `translate(-50%, -50%) rotate(${quad.rotationDegrees}deg) scale(${((quad.flipX ? -1 : 1) * quad.width) / resolved.sourceWidth}, ${((quad.flipY ? -1 : 1) * quad.height) / resolved.sourceHeight})`,
		});
		this.options.mount.style.visibility = "visible";
		incrementCounter({ name: "preview.hyperframesLiveFrame" });
	}

	dispose(): void {
		this.disposed = true;
		window.removeEventListener("message", this.onMessage);
		this.removeSurface();
		this.baseTree = null;
	}

	private hide(): void {
		this.options.mount.style.visibility = "hidden";
	}

	private removeOverlay(): void {
		this.overlayCanvas?.remove();
		this.overlayCanvas = null;
	}

	private async prepareSurface({
		source,
		revision,
	}: {
		source: NonNullable<GraphicNode["params"]["frameSource"]>;
		revision: number;
	}): Promise<void> {
		if (
			this.sourceKey === source.live!.key &&
			this.sourceRevision === revision &&
			this.surface
		) {
			if (this.surface.failed) throw new Error("Live preview is unavailable");
			return this.surface.ready;
		}
		const handle = await source.live!.open();
		const { url } = handle;
		if (this.disposed) {
			handle.release?.();
			throw new Error("Live preview was disposed");
		}
		if (this.failedUrls.has(url)) {
			handle.release?.();
			throw new Error("Live preview needs the capture adapter");
		}
		try {
			if (this.surface?.url !== url || this.sourceRevision !== revision) {
				this.removeSurface();
				// Authenticated host output must stay on the dedicated loopback origin.
				const address = new URL(url);
				if (
					address.protocol !== "http:" ||
					!/^[a-f0-9]{48}\.localhost$/.test(address.hostname) ||
					!address.port ||
					address.username ||
					address.password
				) {
					handle.release?.();
					throw new Error("Invalid live preview origin");
				}
				const frame = document.createElement("iframe");
				frame.title = "HyperFrames composition preview";
				frame.setAttribute("sandbox", "allow-scripts");
				frame.setAttribute(
					"allow",
					"autoplay 'none'; camera 'none'; microphone 'none'",
				);
				frame.setAttribute("aria-hidden", "true");
				frame.tabIndex = -1;
				frame.referrerPolicy = "no-referrer";
				Object.assign(frame.style, {
					position: "absolute",
					border: "0",
					pointerEvents: "none",
					width: `${source.width}px`,
					height: `${source.height}px`,
					transformOrigin: "center",
					background: "transparent",
				});
				let readyResolve!: () => void;
				let readyReject!: (error: Error) => void;
				const ready = new Promise<void>((resolve, reject) => {
					readyResolve = resolve;
					readyReject = reject;
				});
				const surface: Surface = {
					url,
					frame,
					ready,
					readyResolve,
					readyReject,
					sequence: 0,
					failed: false,
					readyTimer: setTimeout(() => this.failSurface(surface), 30_000),
				};
				this.surface = surface;
				frame.src = url;
				this.options.mount.replaceChildren(frame);
			}
			this.sourceKey = source.live!.key;
			this.sourceRevision = revision;
			this.releaseSource?.();
			this.releaseSource = handle.release ?? null;
			await this.surface!.ready;
		} catch (error) {
			handle.release?.();
			throw error;
		}
	}

	private async seek(timeSeconds: number): Promise<void> {
		const surface = this.surface;
		if (!surface || surface.failed)
			throw new Error("Live preview is unavailable");
		const sequence = ++surface.sequence;
		await new Promise<void>((resolve, reject) => {
			surface.waiting = {
				sequence,
				resolve,
				reject,
				timer: setTimeout(() => this.failSurface(surface), 1500),
			};
			surface.frame.contentWindow?.postMessage(
				{ source: "opencut-hf-live", type: "seek", sequence, timeSeconds },
				"*",
			);
		});
	}

	private readonly onMessage = (event: MessageEvent) => {
		const surface = this.surface;
		if (
			!surface ||
			surface.failed ||
			event.source !== surface.frame.contentWindow ||
			!event.data ||
			event.data.source !== "opencut-hf-live"
		)
			return;
		if (event.data.type === "error") {
			console.info(
				"HyperFrames live preview runtime:",
				String(event.data.message).slice(0, 200),
			);
			this.failSurface(surface);
		}
		if (event.data.type === "ready") {
			clearTimeout(surface.readyTimer);
			surface.readyResolve();
		}
		if (
			event.data.type === "frame" &&
			surface.waiting &&
			event.data.sequence === surface.waiting.sequence
		) {
			clearTimeout(surface.waiting.timer);
			surface.waiting.resolve();
			surface.waiting = undefined;
		}
	};

	private failSurface(surface: Surface): void {
		if (this.surface !== surface || surface.failed) return;
		surface.failed = true;
		this.failedUrls.add(surface.url);
		if (this.failedUrls.size > 8)
			this.failedUrls.delete(this.failedUrls.values().next().value!);
		this.hide();
		clearTimeout(surface.readyTimer);
		const error = new Error("Live preview needs the capture adapter");
		surface.readyReject(error);
		if (surface.waiting) {
			clearTimeout(surface.waiting.timer);
			surface.waiting.reject(error);
			surface.waiting = undefined;
		}
		surface.frame.remove();
		this.releaseSource?.();
		this.releaseSource = null;
		this.options.onFallback();
	}

	private removeSurface(): void {
		this.hide();
		this.removeOverlay();
		this.releaseSource?.();
		this.releaseSource = null;
		const surface = this.surface;
		if (surface) {
			clearTimeout(surface.readyTimer);
			const error = new Error("Live preview was replaced");
			surface.readyReject(error);
			if (surface.waiting) {
				clearTimeout(surface.waiting.timer);
				surface.waiting.reject(error);
			}
			surface.frame.remove();
			this.surface = null;
		}
		this.sourceKey = null;
		this.sourceRevision = -1;
	}
}
