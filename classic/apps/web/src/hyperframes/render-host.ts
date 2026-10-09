/** Authenticated app routes supply account/project scope and resolve registered
 * assets. This cache contains derived rendering resources, never editor state.
 */
import { randomUUID } from "node:crypto";
import { prepareHyperframesPreview } from "./preview-document";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import {
	HyperframesCaptureSession,
	type HyperframesFrameArtifact,
} from "./capture-session";
import {
	HyperframesPreviewHost,
	type HyperframesPreviewResource,
} from "./preview-host";
import type {
	HyperframesSource,
	HyperframesRuntimeManifest,
	HyperframesLayerEdits,
	HyperframesLayerRenderEdit,
} from "./types";
import {
	renderHyperframesAudio,
	type HyperframesAudioArtifact,
} from "./audio-render";

export interface HyperframesRenderScope {
	accountId: string;
	projectId: string;
}
export interface HyperframesRenderSession {
	id: string;
	/** Initial capture origin; promotion to a live preview revokes this URL. */
	previewUrl: string;
	fingerprint: string;
	width: number;
	height: number;
	durationSeconds: number;
	runtimeManifest: HyperframesRuntimeManifest;
}
interface Entry {
	scope: HyperframesRenderScope;
	abort: AbortController;
	ready: Promise<HyperframesRenderSession>;
	capture: Promise<HyperframesCaptureSession> | null;
	queue: Promise<void>;
	pending: number;
	pendingFrames: number;
	lastUsed: number;
	source: HyperframesSource;
	layerEdits?: HyperframesLayerEdits;
	resources: ReadonlyMap<string, HyperframesPreviewResource>;
	audio?: Promise<HyperframesAudioArtifact | null>;
	livePreview?: { id: string; url: string };
	liveRequest?: Promise<{ url: string }>;
}
type RenderArtifact = HyperframesFrameArtifact | HyperframesAudioArtifact;
const MAX_ARTIFACT_HANDLES = 2048;
// Leave two of the preview host's eight origins available for a reopened
// capture and a disposable audio probe alongside retained live deliveries.
const MAX_SESSIONS = 6;
const MAX_PENDING_FRAMES = 2;
const IDLE_MS = 2 * 60_000;

export class HyperframesRenderHost {
	private readonly previews = new HyperframesPreviewHost();
	private readonly sessions = new Map<string, Entry>();
	private readonly artifacts = new Map<
		string,
		{ scope: HyperframesRenderScope; artifact: RenderArtifact }
	>();
	private closed = false;
	private audioQueue: Promise<void> = Promise.resolve();
	private readonly timer = setInterval(() => this.prune(), 30_000);

	constructor(private readonly runtime: CanonicalEditorRuntime) {
		this.timer.unref();
	}

	async open({
		scope,
		source,
		layerEdits,
		resolveResource,
		signal,
	}: {
		scope: HyperframesRenderScope;
		source: HyperframesSource;
		layerEdits?: HyperframesLayerEdits;
		resolveResource: (
			assetId: string,
		) => Promise<HyperframesPreviewResource | null>;
		signal?: AbortSignal;
	}): Promise<HyperframesRenderSession> {
		signal?.throwIfAborted();
		if (this.closed) throw new Error("The HyperFrames render host is closed");
		this.runtime.invokeSync(
			"hyperframes.project.inspect",
			{ source },
			undefined,
		);
		const resources = new Map<string, HyperframesPreviewResource>();
		for (const [path, assetId] of Object.entries(source.resourceAssetIds)) {
			signal?.throwIfAborted();
			const resource = await resolveResource(assetId);
			if (!resource)
				throw new Error(`Link the missing HyperFrames resource: ${path}`);
			resources.set(path, resource);
		}
		if (this.closed) throw new Error("The HyperFrames render host is closed");
		if (this.sessions.size >= MAX_SESSIONS)
			throw new Error(
				"Close an existing HyperFrames render before opening another",
			);
		const id = randomUUID();
		const abort = new AbortController();
		const capture = HyperframesCaptureSession.open({
			source,
			layerEdits,
			resources,
			runtime: this.runtime,
			host: this.previews,
			signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
		});
		const ready = capture.then((session) => ({
			id,
			previewUrl: session.previewUrl,
			fingerprint: session.inspection.fingerprint,
			width: session.inspection.width,
			height: session.inspection.height,
			durationSeconds: session.durationSeconds,
			runtimeManifest: session.runtimeManifest,
		}));
		const entry: Entry = {
			scope: { ...scope },
			abort,
			capture,
			ready,
			queue: ready.then(
				() => {},
				() => {},
			),
			pending: 1,
			pendingFrames: 0,
			lastUsed: Date.now(),
			source: structuredClone(source),
			layerEdits: layerEdits && structuredClone(layerEdits),
			resources,
		};
		this.sessions.set(id, entry);
		try {
			const result = await ready;
			signal?.throwIfAborted();
			if (this.closed || abort.signal.aborted)
				throw new Error("The HyperFrames render was closed while loading");
			return structuredClone(result);
		} catch (error) {
			this.sessions.delete(id);
			await capture.then(
				(session) => session.close(),
				() => {},
			);
			throw error;
		} finally {
			entry.pending--;
			entry.lastUsed = Date.now();
		}
	}

	async capture({
		scope,
		id,
		timeSeconds,
		previewScale,
		signal,
	}: {
		scope: HyperframesRenderScope;
		id: string;
		timeSeconds: number;
		previewScale?: number;
		signal?: AbortSignal;
	}): Promise<HyperframesFrameArtifact> {
		signal?.throwIfAborted();
		const entry = this.getEntry({ scope, id });
		if (entry.pendingFrames >= MAX_PENDING_FRAMES)
			throw new Error("The HyperFrames capture queue is full");
		entry.pendingFrames++;
		const cancellation = signal
			? AbortSignal.any([signal, entry.abort.signal])
			: entry.abort.signal;
		try {
			return await this.enqueue(entry, async () => {
				cancellation.throwIfAborted();
				entry.capture ??= HyperframesCaptureSession.open({
					source: entry.source,
					layerEdits: entry.layerEdits,
					resources: entry.resources,
					runtime: this.runtime,
					host: this.previews,
					signal: cancellation,
				});
				const session = await entry.capture;
				const artifact = await session.capture({
					timeSeconds,
					previewScale,
					signal: cancellation,
				});
				if (this.closed || this.sessions.get(id) !== entry) {
					this.runtime.removeArtifact(artifact.uri);
					throw new Error("The HyperFrames render was closed during capture");
				}
				this.retainArtifact({ scope, artifact });
				return artifact;
			});
		} finally {
			entry.pendingFrames--;
		}
	}

	async livePreview({
		scope,
		id,
	}: {
		scope: HyperframesRenderScope;
		id: string;
	}): Promise<{ url: string }> {
		const entry = this.getEntry({ scope, id });
		if (entry.liveRequest) return entry.liveRequest;
		const task = this.enqueue(entry, async () => {
			const ready = await entry.ready;
			entry.abort.signal.throwIfAborted();
			// Wait for earlier captures, then release Chrome and its source origin.
			// The immutable manifest and scoped resources outlive that browser. A
			// later screenshot/export lazily reopens it on this same queue.
			await this.releaseCapture(entry);
			entry.abort.signal.throwIfAborted();
			if (
				entry.livePreview &&
				this.previews.keepAlive({ id: entry.livePreview.id })
			)
				return { url: entry.livePreview.url };
			let layerPlan: HyperframesLayerRenderEdit[] | undefined;
			if (entry.layerEdits) {
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Canonical validated plan from the observed manifest.
				const receipt = this.runtime.invokeSync(
					"hyperframes.layers.render.prepare",
					{
						source: entry.source,
						manifest: ready.runtimeManifest,
						edits: entry.layerEdits,
					},
					undefined,
				) as { result: { data: { layers: HyperframesLayerRenderEdit[] } } };
				layerPlan = receipt.result.data.layers;
			}
			const prepared = prepareHyperframesPreview({
				layerPlan,
				source: entry.source,
				runtime: this.runtime,
				signal: entry.abort.signal,
				liveDurationSeconds: ready.durationSeconds,
			});
			const preview = await this.previews.add({
				source: entry.source,
				resources: entry.resources,
				html: prepared.html,
				live: true,
			});
			if (
				this.closed ||
				this.sessions.get(id) !== entry ||
				entry.abort.signal.aborted
			) {
				this.previews.remove({ id: preview.id });
				throw new Error(
					"The HyperFrames live preview was closed while loading",
				);
			}
			entry.livePreview = preview;
			return { url: preview.url };
		});
		entry.liveRequest = task;
		try {
			return await task;
		} finally {
			if (entry.liveRequest === task) entry.liveRequest = undefined;
		}
	}

	async audio({
		scope,
		id,
		signal,
	}: {
		scope: HyperframesRenderScope;
		id: string;
		signal?: AbortSignal;
	}): Promise<HyperframesAudioArtifact | null> {
		signal?.throwIfAborted();
		const entry = this.getEntry({ scope, id });
		if (entry.audio) {
			const pending = entry.audio;
			const cached = await pending;
			signal?.throwIfAborted();
			this.getEntry({ scope, id });
			if (!cached) return null;
			try {
				this.readArtifact({ scope, id: cached.id });
				return cached;
			} catch {
				if (entry.audio !== pending) return this.audio({ scope, id, signal });
				entry.audio = undefined;
			}
		}
		const cancellation = signal
			? AbortSignal.any([signal, entry.abort.signal])
			: entry.abort.signal;
		const task = this.audioQueue.then(async () => {
			cancellation.throwIfAborted();
			if (this.getEntry({ scope, id }) !== entry)
				throw new Error("HyperFrames audio session changed");
			await entry.ready;
			if (!(await this.keepAlive({ scope, id })))
				throw new Error("HyperFrames render session expired");
			const keepAlive = setInterval(() => {
				void this.keepAlive({ scope, id }).catch(() => {});
			}, 30_000);
			keepAlive.unref();
			try {
				const probe = await HyperframesCaptureSession.open({
					source: entry.source,
					resources: entry.resources,
					runtime: this.runtime,
					host: this.previews,
					signal: cancellation,
				});
				const plan = await probe.consumeAudioPlan({
					source: entry.source,
					signal: cancellation,
				});
				const artifact = await renderHyperframesAudio({
					source: entry.source,
					plan,
					resources: entry.resources,
					runtime: this.runtime,
					signal: cancellation,
				});
				if (
					this.closed ||
					this.sessions.get(id) !== entry ||
					cancellation.aborted
				) {
					if (artifact) this.runtime.removeArtifact(artifact.id);
					throw new Error(
						"The HyperFrames render was closed during audio mixing",
					);
				}
				if (artifact) this.retainArtifact({ scope, artifact });
				return artifact;
			} finally {
				clearInterval(keepAlive);
			}
		});
		entry.audio = task;
		this.audioQueue = task.then(
			() => {},
			() => {},
		);
		try {
			return await task;
		} catch (error) {
			if (entry.audio === task) entry.audio = undefined;
			throw error;
		}
	}

	private retainArtifact({
		scope,
		artifact,
	}: {
		scope: HyperframesRenderScope;
		artifact: RenderArtifact;
	}): void {
		this.prune();
		while (this.artifacts.size >= MAX_ARTIFACT_HANDLES) {
			const oldest = this.artifacts.keys().next().value;
			if (!oldest) break;
			this.artifacts.delete(oldest);
			this.runtime.removeArtifact(oldest);
		}
		this.artifacts.set(artifact.id, { scope: { ...scope }, artifact });
	}

	readArtifact({ scope, id }: { scope: HyperframesRenderScope; id: string }): {
		bytes: Uint8Array;
		artifact: RenderArtifact;
	} {
		const entry = this.artifacts.get(id);
		if (
			this.closed ||
			!entry ||
			!sameScope(scope, entry.scope) ||
			entry.artifact.expiresAtMs <= Date.now()
		)
			throw new Error("HyperFrames artifact is unavailable");
		return { bytes: this.runtime.readArtifact(id), artifact: entry.artifact };
	}

	async keepAlive({
		scope,
		id,
	}: {
		scope: HyperframesRenderScope;
		id: string;
	}): Promise<boolean> {
		const entry = this.getEntry({ scope, id });
		await entry.ready;
		const capture = entry.capture;
		if (capture && !(await capture).keepAlive() && entry.capture === capture)
			return false;
		if (this.closed || this.sessions.get(id) !== entry) return false;
		entry.lastUsed = Date.now();
		const live = entry.livePreview;
		if (live && !this.previews.keepAlive({ id: live.id }))
			entry.livePreview = undefined;
		return true;
	}

	async closeSession({
		scope,
		id,
	}: {
		scope: HyperframesRenderScope;
		id: string;
	}): Promise<void> {
		const entry = this.getEntry({ scope, id });
		this.sessions.delete(id);
		entry.abort.abort();
		await this.disposeEntry(entry);
		await entry.audio?.catch(() => {});
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		const pending = [...this.sessions.values()];
		this.sessions.clear();
		for (const entry of pending) entry.abort.abort();
		await Promise.all(pending.map((entry) => this.disposeEntry(entry)));
		await this.audioQueue;
		await this.previews.close();
		for (const id of this.artifacts.keys()) this.runtime.removeArtifact(id);
		this.artifacts.clear();
	}

	private getEntry({
		scope,
		id,
	}: {
		scope: HyperframesRenderScope;
		id: string;
	}): Entry {
		const entry = this.sessions.get(id);
		if (this.closed || !entry || !sameScope(scope, entry.scope))
			throw new Error("HyperFrames render session is unavailable");
		return entry;
	}

	private prune(): void {
		for (const [id, entry] of this.artifacts) {
			if (entry.artifact.expiresAtMs <= Date.now()) this.artifacts.delete(id);
		}
		for (const [id, entry] of this.sessions) {
			if (!entry.pending && Date.now() - entry.lastUsed > IDLE_MS) {
				this.sessions.delete(id);
				entry.abort.abort();
				void this.disposeEntry(entry).catch(() => {});
				continue;
			}
			const capture = entry.capture;
			void capture?.then(
				(session) => {
					if (
						session.isClosed &&
						entry.capture === capture &&
						this.sessions.get(id) === entry
					) {
						this.sessions.delete(id);
						entry.abort.abort();
						void this.disposeEntry(entry).catch(() => {});
					}
				},
				() => {
					if (entry.capture === capture && this.sessions.get(id) === entry) {
						this.sessions.delete(id);
						entry.abort.abort();
						void this.disposeEntry(entry).catch(() => {});
					}
				},
			);
		}
	}

	/** Lifecycle changes and screenshots share one queue; a promotion cannot
	 * close a browser in the middle of a frame or race a lazy reopen. */
	// eslint-disable-next-line opencut/prefer-object-params -- Internal queue helper pairs the entry with its operation.
	private enqueue<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
		entry.pending++;
		const task = entry.queue
			.then(async () => {
				entry.abort.signal.throwIfAborted();
				return operation();
			})
			.finally(() => {
				entry.pending--;
				entry.lastUsed = Date.now();
			});
		entry.queue = task.then(
			() => {},
			() => {},
		);
		return task;
	}

	private async releaseCapture(entry: Entry): Promise<void> {
		const capture = entry.capture;
		entry.capture = null;
		await capture?.then(
			(session) => session.close(),
			() => {},
		);
	}

	private async disposeEntry(entry: Entry): Promise<void> {
		await entry.queue;
		if (entry.livePreview) this.previews.remove({ id: entry.livePreview.id });
		entry.livePreview = undefined;
		await this.releaseCapture(entry);
	}
}

// eslint-disable-next-line opencut/prefer-object-params -- Small scope comparator, no policy beyond exact ownership equality.
function sameScope(
	left: HyperframesRenderScope,
	right: HyperframesRenderScope,
): boolean {
	return (
		left.accountId === right.accountId && left.projectId === right.projectId
	);
}
