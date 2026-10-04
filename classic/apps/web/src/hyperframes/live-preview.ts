import type { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { computeVisualTransform } from "@/services/renderer/compositor/frame-descriptor";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { GraphicNode } from "@/services/renderer/nodes/graphic-node";
import { VisualNode } from "@/services/renderer/nodes/visual-node";
import { TextNode } from "@/services/renderer/nodes/text-node";
import { resolveGraphicNodeLayout } from "@/services/renderer/resolve";
import { incrementCounter } from "@/diagnostics/render-perf";

const MAX_LIVE_OCCURRENCES = 4;
type ResolvedLayout = NonNullable<ReturnType<typeof resolveGraphicNodeLayout>>;

/** Split only across source-over leaves. Backdrop-dependent blend modes and
 * scene wrappers stay in the opaque base, below any eligible live surfaces. */
export function findHyperframesLiveLayers({
	node,
	time,
}: {
	node: RootNode;
	time: number;
}): GraphicNode[] {
	const candidates: GraphicNode[] = [];
	for (let index = node.children.length - 1; index >= 0; index--) {
		const child = node.children[index];
		if (!(child instanceof VisualNode || child instanceof TextNode)) break;
		const start =
			child instanceof TextNode
				? child.params.startTime
				: child.params.timeOffset;
		if (time < start || time >= start + child.params.duration) continue;
		if (
			(child.params.blendMode && child.params.blendMode !== "normal") ||
			child.children.length
		)
			break;
		if (
			child instanceof GraphicNode &&
			child.params.definitionId === "hyperframes" &&
			child.params.isPreview &&
			child.params.frameSource?.live &&
			!child.params.effects?.length &&
			!child.params.masks?.length
		) {
			candidates.unshift(child);
			if (candidates.length === MAX_LIVE_OCCURRENCES) break;
		}
	}
	return candidates;
}

/** Highest eligible layer, retained for callers that inspect a single target. */
export function findHyperframesLiveLayer(input: {
	node: RootNode;
	time: number;
}): GraphicNode | null {
	return findHyperframesLiveLayers(input).at(-1) ?? null;
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

type Candidate = {
	node: GraphicNode;
	resolved: ResolvedLayout;
	occurrenceId: string;
};
type Options = {
	mount: HTMLElement;
	width: number;
	height: number;
	onFallback: () => void;
};

/** Derived display resources only. Every occurrence reads its canonical clip's
 * time/layout and shares source delivery through independently released leases. */
export class HyperframesLivePreview {
	private readonly occurrences = new Map<string, LiveOccurrence>();
	private readonly overlays = new Map<string, HTMLCanvasElement>();
	private readonly failedSources = new WeakMap<object, number>();
	private readonly failedUrls = new Set<string>();
	private baseTree: {
		original: RootNode;
		omitted: GraphicNode[];
		tree: RootNode;
		groups: Array<{ node: RootNode; occurrenceId: string }>;
	} | null = null;
	private disposed = false;

	constructor(private readonly options: Options) {
		this.hide();
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
		if (this.disposed) return;
		const candidates: Candidate[] = [];
		for (const candidate of findHyperframesLiveLayers({ node, time })) {
			const source = candidate.params.frameSource!;
			if (
				this.failedSources.get(source.live!.key) ===
				source.getResourceRevision()
			)
				continue;
			const resolved = resolveGraphicNodeLayout({
				node: candidate,
				renderer: this.options,
				time,
			});
			if (
				!resolved ||
				resolved.effectPasses.length ||
				resolved.transform.perspectiveX ||
				resolved.transform.perspectiveY
			)
				continue;
			candidates.push({
				node: candidate,
				resolved,
				occurrenceId: source.live!.occurrenceId,
			});
		}
		// Release departed occurrences before acquiring new sources at the limit.
		this.retainOccurrences(
			new Set(candidates.map((candidate) => candidate.occurrenceId)),
		);
		const prepared = await Promise.all(
			candidates.map(async (candidate) => {
				let occurrence = this.occurrences.get(candidate.occurrenceId);
				if (!occurrence) {
					occurrence = new LiveOccurrence({
						...this.options,
						failedSources: this.failedSources,
						failedUrls: this.failedUrls,
						onFallback: () => {
							if (this.disposed) return;
							this.hide();
							this.options.onFallback();
						},
					});
					this.occurrences.set(candidate.occurrenceId, occurrence);
				}
				return (await occurrence.prepare(candidate)) ? candidate : null;
			}),
		);
		if (this.disposed) return;
		const live = prepared.filter(
			(candidate): candidate is Candidate => candidate !== null,
		);
		this.retainOccurrences(
			new Set(live.map((candidate) => candidate.occurrenceId)),
		);
		if (!live.length) {
			this.hide();
			this.clearOverlays();
			this.baseTree = null;
			await renderer.render({ node, time });
			return;
		}
		const omitted = live.map((candidate) => candidate.node);
		if (
			this.baseTree?.original !== node ||
			this.baseTree.omitted.length !== omitted.length ||
			this.baseTree.omitted.some(
				(candidate, index) => candidate !== omitted[index],
			)
		) {
			const roots: RootNode[] = [];
			let start = 0;
			for (const candidate of omitted) {
				const end = node.children.indexOf(candidate);
				const root = new RootNode(node.params);
				root.children = node.children.slice(start, end);
				roots.push(root);
				start = end + 1;
			}
			const tail = new RootNode(node.params);
			tail.children = node.children.slice(start);
			roots.push(tail);
			this.baseTree = {
				original: node,
				omitted,
				tree: roots[0],
				groups: live.map((candidate, index) => ({
					node: roots[index + 1],
					occurrenceId: candidate.occurrenceId,
				})),
			};
		}
		const overlays = [];
		const used = new Set<string>();
		for (const [index, group] of this.baseTree.groups.entries()) {
			if (!group.node.children.length) continue;
			let canvas = this.overlays.get(group.occurrenceId);
			if (!canvas) {
				canvas = document.createElement("canvas");
				canvas.setAttribute("aria-hidden", "true");
				Object.assign(canvas.style, {
					position: "absolute",
					inset: "0",
					pointerEvents: "none",
					width: `${this.options.width}px`,
					height: `${this.options.height}px`,
				});
				this.overlays.set(group.occurrenceId, canvas);
				this.options.mount.appendChild(canvas);
			}
			if (canvas.width !== renderer.width) canvas.width = renderer.width;
			if (canvas.height !== renderer.height) canvas.height = renderer.height;
			canvas.style.zIndex = String(index * 2 + 2);
			used.add(group.occurrenceId);
			overlays.push({ node: group.node, targetCanvas: canvas });
		}
		for (const [id, canvas] of this.overlays) {
			if (!used.has(id)) {
				canvas.remove();
				this.overlays.delete(id);
			}
		}
		try {
			if (overlays.length)
				await renderer.renderWithOverlays({
					node: this.baseTree.tree,
					overlays,
					time,
				});
			else await renderer.render({ node: this.baseTree.tree, time });
		} catch (error) {
			this.hide();
			throw error;
		}
		if (this.disposed) return;
		for (const [index, candidate] of live.entries()) {
			if (
				!this.occurrences
					.get(candidate.occurrenceId)
					?.present({ ...candidate, zIndex: index * 2 + 1 })
			) {
				this.hide();
				await renderer.render({ node, time });
				return;
			}
		}
		this.options.mount.style.visibility = "visible";
	}

	dispose(): void {
		this.disposed = true;
		this.hide();
		this.retainOccurrences(new Set());
		this.clearOverlays();
		this.baseTree = null;
	}

	private hide(): void {
		this.options.mount.style.visibility = "hidden";
	}
	private clearOverlays(): void {
		for (const canvas of this.overlays.values()) canvas.remove();
		this.overlays.clear();
	}
	private retainOccurrences(ids: ReadonlySet<string>): void {
		for (const [id, occurrence] of this.occurrences) {
			if (!ids.has(id)) {
				occurrence.dispose();
				this.occurrences.delete(id);
			}
		}
	}
}

class LiveOccurrence {
	private surface: Surface | null = null;
	private sourceKey: object | null = null;
	private sourceRevision = -1;
	private releaseSource: (() => void) | null = null;
	private disposed = false;
	private readonly failedSources: WeakMap<object, number>;
	private readonly failedUrls: Set<string>;

	constructor(
		private readonly options: Options & {
			failedSources: WeakMap<object, number>;
			failedUrls: Set<string>;
		},
	) {
		this.failedSources = options.failedSources;
		this.failedUrls = options.failedUrls;
		window.addEventListener("message", this.onMessage);
	}

	async prepare({ node: candidate, resolved }: Candidate): Promise<boolean> {
		const source = candidate.params.frameSource!;
		const revision = source.getResourceRevision();
		try {
			await this.prepareSurface({ source, revision });
			await this.seek(source.live!.getSourceTime(resolved.localTime));
			if (source.getResourceRevision() !== revision)
				throw new Error("Live preview resources changed");
			return !this.disposed;
		} catch (error) {
			this.failedSources.set(source.live!.key, revision);
			this.hide();
			if (!this.disposed)
				console.info(
					"HyperFrames live preview is using capture:",
					error instanceof Error ? error.message : "Preview unavailable",
				);
			incrementCounter({ name: "preview.hyperframesLiveFallback" });
			return false;
		}
	}

	present({
		node: candidate,
		resolved,
		zIndex,
	}: Candidate & { zIndex: number }): boolean {
		if (this.disposed || !this.surface || this.surface.failed) return false;
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
		Object.assign(this.surface!.frame.style, {
			width: `${resolved.sourceWidth}px`,
			height: `${resolved.sourceHeight}px`,
			left: `${quad.centerX}px`,
			top: `${quad.centerY}px`,
			opacity: String(resolved.opacity),
			transform: `translate(-50%, -50%) rotate(${quad.rotationDegrees}deg) scale(${((quad.flipX ? -1 : 1) * quad.width) / resolved.sourceWidth}, ${((quad.flipY ? -1 : 1) * quad.height) / resolved.sourceHeight})`,
		});
		this.surface!.frame.style.visibility = "visible";
		this.surface!.frame.style.zIndex = String(zIndex);
		incrementCounter({ name: "preview.hyperframesLiveFrame" });
		return true;
	}

	dispose(): void {
		this.disposed = true;
		window.removeEventListener("message", this.onMessage);
		this.removeSurface();
	}
	private hide(): void {
		if (this.surface) this.surface.frame.style.visibility = "hidden";
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
		this.releaseSource?.();
		this.releaseSource = null;
		const handle = await source.live!.open();
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			handle.release?.();
		};
		const { url } = handle;
		if (this.disposed) {
			release();
			throw new Error("Live preview was disposed");
		}
		if (this.failedUrls.has(url)) {
			release();
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
					release();
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
					visibility: "hidden",
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
				this.options.mount.appendChild(frame);
			}
			this.sourceKey = source.live!.key;
			this.sourceRevision = revision;
			this.releaseSource = release;
			await this.surface!.ready;
		} catch (error) {
			release();
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
