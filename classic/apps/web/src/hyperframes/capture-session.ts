/** Persistent, isolated rendering adapter for the Classic compositor.
 * Editor state and source validation belong to OpenCutRuntime. This class owns
 * only a derived page, its serialized capture queue, and bounded output handles.
 */
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertPublicHttpsUrl,
	captureFrameToBuffer,
	closeCaptureSession,
	compositionRequiresWebGpu,
	createCaptureSession,
	getCompositionDuration,
	initializeSession,
	type CaptureSession,
	type CaptureWarning,
} from "@hyperframes/engine";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import { prepareHyperframesPreview } from "./preview-document";
import {
	HyperframesPreviewHost,
	type HyperframesPreviewResource,
} from "./preview-host";
import type {
	HyperframesInspection,
	HyperframesSource,
	HyperframesRuntimeManifest,
} from "./types";
import { readHyperframesRuntimeManifest } from "./runtime-manifest";

export interface HyperframesFrameArtifact {
	id: string;
	uri: string;
	mimeType: string;
	byteSize: number;
	sha256: string;
	createdAtMs: number;
	expiresAtMs: number;
	width: number;
	height: number;
	durationMs: null;
}

const MAX_SESSIONS = 4;
const MAX_PENDING_FRAMES = 2;
const IDLE_MS = 2 * 60_000;
const FRAME_TIMEOUT_MS = 30_000;
const active = new Set<HyperframesCaptureSession>();

export class HyperframesCaptureSession {
	readonly inspection: HyperframesInspection;
	private engine: CaptureSession | null = null;
	private previewId: string | null = null;
	private sourceUrl: string | null = null;
	private scratchDirectory: string | null = null;
	private closing: Promise<void> | null = null;
	private closed = false;
	private queue: Promise<void> = Promise.resolve();
	private pending = 0;
	private lastUsed = Date.now();
	private timer: ReturnType<typeof setInterval> | null = null;
	private resolvedDuration = 0;
	private resolvedManifest: HyperframesRuntimeManifest | null = null;
	private capturedWarnings: CaptureWarning[] = [];
	private readonly runtime: CanonicalEditorRuntime;
	private readonly host: HyperframesPreviewHost;

	private constructor({
		runtime,
		host,
		inspection,
	}: {
		runtime: CanonicalEditorRuntime;
		host: HyperframesPreviewHost;
		inspection: HyperframesInspection;
	}) {
		this.runtime = runtime;
		this.host = host;
		this.inspection = inspection;
	}

	static async open({
		source,
		resources,
		runtime,
		host,
		signal,
		chromePath,
	}: {
		source: HyperframesSource;
		resources: ReadonlyMap<string, HyperframesPreviewResource>;
		runtime: CanonicalEditorRuntime;
		host: HyperframesPreviewHost;
		signal?: AbortSignal;
		/** Host configuration only; never take an executable path from a request. */
		chromePath?: string;
	}): Promise<HyperframesCaptureSession> {
		signal?.throwIfAborted();
		if (active.size >= MAX_SESSIONS)
			throw new Error(
				"Close an existing HyperFrames render before opening another",
			);
		const prepared = prepareHyperframesPreview({ source, runtime, signal });
		const result = new HyperframesCaptureSession({
			runtime,
			host,
			inspection: prepared.inspection,
		});
		active.add(result); // Reserve before any asynchronous work.
		try {
			await result.initialize({
				source,
				resources,
				html: prepared.html,
				signal,
				chromePath,
			});
			return result;
		} catch (error) {
			await result.close();
			throw error;
		}
	}

	get durationSeconds(): number {
		return this.resolvedDuration;
	}

	get runtimeManifest(): HyperframesRuntimeManifest {
		if (!this.resolvedManifest)
			throw new Error("HyperFrames runtime manifest is unavailable");
		return structuredClone(this.resolvedManifest);
	}

	get previewUrl(): string {
		if (this.closed || !this.sourceUrl)
			throw new Error("The HyperFrames capture is closed");
		return this.sourceUrl;
	}

	keepAlive(): boolean {
		if (
			this.closed ||
			!this.previewId ||
			!this.host.keepAlive({ id: this.previewId })
		)
			return false;
		this.lastUsed = Date.now();
		return true;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get warnings(): CaptureWarning[] {
		return structuredClone(this.engine?.warnings ?? this.capturedWarnings);
	}

	private async initialize({
		source,
		resources,
		html,
		signal,
		chromePath,
	}: {
		source: HyperframesSource;
		resources: ReadonlyMap<string, HyperframesPreviewResource>;
		html: string;
		signal?: AbortSignal;
		chromePath?: string;
	}): Promise<void> {
		const { width, height, fps } = this.inspection;
		if (width * height > 16_777_216)
			throw new Error(
				"HyperFrames capture exceeds the 16-megapixel frame limit",
			);
		const preview = await this.host.add({ source, resources, html });
		this.previewId = preview.id;
		this.sourceUrl = preview.url;
		signal?.throwIfAborted();
		// The official engine requires an output directory even for its buffer
		// API. No frames are written here; rmdir removes only an empty directory.
		this.scratchDirectory = await mkdtemp(
			join(tmpdir(), "opencut-hyperframes-"),
		);
		this.engine = await createCaptureSession(
			new URL(preview.url).origin,
			this.scratchDirectory,
			{
				entryUrl: preview.url,
				requiresWebGpu: compositionRequiresWebGpu(html),
				width,
				height,
				fps: { num: Math.round(fps * 1_000_000), den: 1_000_000 },
				format: "png",
				compositionDurationSeconds:
					this.inspection.durationSeconds ?? undefined,
			},
			null,
			{
				chromePath,
				forceScreenshot: true,
				useDrawElement: false,
				browserGpuMode: "software",
				enableBrowserPool: false,
				staticFrameDedup: false, // Scrubbing may seek in any order.
				browserTimeout: 30_000,
				pageNavigationTimeout: 30_000,
				playerReadyTimeout: 30_000,
				protocolTimeout: FRAME_TIMEOUT_MS,
			},
		);
		signal?.throwIfAborted();
		const engine = this.engine;
		await engine.page.evaluateOnNewDocument((renderFps: number) => {
			// The official runtime exposes __player; the engine consumes __hf.
			// Adapt that protocol without reimplementing timing or animation logic.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- These fields are installed by the pinned runtime in the isolated page.
			const page = window as unknown as {
				__HF_RENDER_CAPTURE_MODE?: boolean;
				__HF_EXPORT_RENDER_SEEK_CONFIG?: Record<string, unknown>;
				__renderReady?: boolean;
				__hfTimelinesBuilding?: boolean;
				__player?: {
					renderSeek: (time: number, options?: unknown) => void;
					getDuration: () => number;
				};
				__hf?: {
					seek?: (time: number, options?: unknown) => void;
					duration?: number;
				};
			};
			page.__HF_RENDER_CAPTURE_MODE = true;
			page.__HF_EXPORT_RENDER_SEEK_CONFIG = {
				mode: "preview-phase",
				step: 1 / 120,
				offsetFraction: 0.5,
				fps: renderFps,
				fpsSource: "render-options",
				owner: "runtime",
			};
			const bridge = setInterval(() => {
				const player = page.__player;
				if (
					typeof player?.renderSeek !== "function" ||
					typeof player.getDuration !== "function"
				)
					return;
				const hf = (page.__hf ??= {});
				Object.defineProperty(hf, "duration", {
					configurable: true,
					enumerable: true,
					get: () =>
						page.__renderReady && !page.__hfTimelinesBuilding
							? player.getDuration()
							: 0,
				});
				// eslint-disable-next-line opencut/prefer-object-params -- The engine's seek protocol takes positional arguments.
				hf.seek = (time, options) => player.renderSeek(time, options);
				clearInterval(bridge);
			}, 20);
		}, fps);
		const launchArgs = engine.browser.process()?.spawnargs ?? [];
		if (
			launchArgs.some((arg) =>
				/^(--no-sandbox|--disable-setuid-sandbox|--disable-web-security)(=|$)/.test(
					arg,
				),
			)
		)
			throw new Error(
				"HyperFrames requires the sandboxed OpenCut engine patch",
			);
		const origin = new URL(preview.url).origin;
		await engine.page.setRequestInterception(true);
		engine.page.on("request", (request) => {
			try {
				const url = new URL(request.url());
				if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
					throw new Error("Render requests are read-only");
				if (
					request.isNavigationRequest() &&
					request.frame() === engine.page.mainFrame() &&
					url.href !== preview.url
				)
					throw new Error("The composition cannot navigate the capture page");
				if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol))
					assertPublicHttpsUrl(url.href);
				void request.continue().catch(() => {});
			} catch {
				void request.abort("blockedbyclient").catch(() => {});
			}
		});
		const abort = () => {
			void this.close();
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			signal?.throwIfAborted();
			await initializeSession(engine);
			// PNG initialization clears authored html/body backgrounds in 0.8.115.
			// Preserve those backgrounds while retaining Chrome's transparent default.
			await engine.page.evaluate(() => {
				document.getElementById("__hf_transparent_bg__")?.remove();
			});
			this.resolvedDuration =
				this.inspection.durationSeconds ??
				(await getCompositionDuration(engine));
			if (!Number.isFinite(this.resolvedDuration) || this.resolvedDuration <= 0)
				throw new Error(
					"HyperFrames did not resolve a finite positive duration",
				);
			this.resolvedManifest = await readHyperframesRuntimeManifest({
				page: engine.page,
				source,
				fingerprint: this.inspection.fingerprint,
				durationSeconds: this.resolvedDuration,
				runtime: this.runtime,
			});
			signal?.throwIfAborted();
			if (this.closed)
				throw new Error("The HyperFrames capture was closed while loading");
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		this.timer = setInterval(() => {
			if (!this.pending && Date.now() - this.lastUsed > IDLE_MS)
				void this.close();
		}, 30_000);
		this.timer.unref();
	}

	async capture({
		timeSeconds,
		signal,
	}: {
		timeSeconds: number;
		signal?: AbortSignal;
	}): Promise<HyperframesFrameArtifact> {
		signal?.throwIfAborted();
		if (this.closed || !this.engine)
			throw new Error("The HyperFrames capture is closed");
		if (
			!Number.isFinite(timeSeconds) ||
			timeSeconds < 0 ||
			timeSeconds >= this.resolvedDuration
		)
			throw new Error("Capture time must be inside the composition duration");
		if (this.pending >= MAX_PENDING_FRAMES)
			throw new Error("The HyperFrames capture queue is full");
		this.pending++;
		const task = this.queue.then(async () => {
			signal?.throwIfAborted();
			const engine = this.engine;
			if (this.closed || !engine)
				throw new Error("The HyperFrames capture is closed");
			if (!this.previewId || !this.host.keepAlive({ id: this.previewId }))
				throw new Error("The HyperFrames source preview expired");
			this.lastUsed = Date.now();
			const deadline = AbortSignal.timeout(FRAME_TIMEOUT_MS);
			const cancellation = signal
				? AbortSignal.any([signal, deadline])
				: deadline;
			const abort = () => {
				void this.close();
			};
			cancellation.addEventListener("abort", abort, { once: true });
			try {
				cancellation.throwIfAborted();
				const frameIndex = Math.floor(timeSeconds * this.inspection.fps);
				const { buffer } = await captureFrameToBuffer(
					engine,
					frameIndex,
					timeSeconds,
				);
				cancellation.throwIfAborted();
				if (this.closed) throw new Error("The HyperFrames capture is closed");
				// The Rust ArtifactStore owns limits, checksums, expiry and eviction.
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Artifact metadata is constructed and validated by the Rust store.
				return this.runtime.storeArtifact(
					buffer,
					"image/png",
					this.inspection.width,
					this.inspection.height,
					undefined,
				) as HyperframesFrameArtifact;
			} catch (error) {
				await this.close(); // A failed seek can leave the page partially advanced.
				cancellation.throwIfAborted();
				throw error;
			} finally {
				cancellation.removeEventListener("abort", abort);
				this.lastUsed = Date.now();
			}
		});
		this.queue = task.then(
			() => {},
			() => {},
		);
		try {
			return await task;
		} finally {
			this.pending--;
		}
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		if (this.previewId) this.host.remove({ id: this.previewId });
		this.closing = (async () => {
			try {
				if (this.engine) {
					this.capturedWarnings = structuredClone(this.engine.warnings);
					await closeCaptureSession(this.engine);
				}
			} finally {
				this.engine = null;
				if (this.scratchDirectory)
					await rmdir(this.scratchDirectory).catch(() => {});
				active.delete(this);
			}
		})();
		return this.closing;
	}
}
