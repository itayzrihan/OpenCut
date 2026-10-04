/** Authenticated app routes supply account/project scope and resolve registered
 * assets. This cache contains derived rendering resources, never editor state.
 */
import { randomUUID } from "node:crypto";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import {
	HyperframesCaptureSession,
	type HyperframesFrameArtifact,
} from "./capture-session";
import {
	HyperframesPreviewHost,
	type HyperframesPreviewResource,
} from "./preview-host";
import type { HyperframesSource, HyperframesRuntimeManifest } from "./types";
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
	capture: Promise<HyperframesCaptureSession>;
	source: HyperframesSource;
	resources: ReadonlyMap<string, HyperframesPreviewResource>;
	audio?: Promise<HyperframesAudioArtifact | null>;
}
type RenderArtifact = HyperframesFrameArtifact | HyperframesAudioArtifact;
const MAX_ARTIFACT_HANDLES = 2048;

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
		resolveResource,
		signal,
	}: {
		scope: HyperframesRenderScope;
		source: HyperframesSource;
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
		const id = randomUUID();
		const abort = new AbortController();
		const capture = HyperframesCaptureSession.open({
			source,
			resources,
			runtime: this.runtime,
			host: this.previews,
			signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
		});
		const entry: Entry = {
			scope: { ...scope },
			abort,
			capture,
			source: structuredClone(source),
			resources,
		};
		this.sessions.set(id, entry);
		try {
			const ready = await capture;
			signal?.throwIfAborted();
			if (this.closed || abort.signal.aborted)
				throw new Error("The HyperFrames render was closed while loading");
			return {
				id,
				previewUrl: ready.previewUrl,
				fingerprint: ready.inspection.fingerprint,
				width: ready.inspection.width,
				height: ready.inspection.height,
				durationSeconds: ready.durationSeconds,
				runtimeManifest: ready.runtimeManifest,
			};
		} catch (error) {
			this.sessions.delete(id);
			await capture.then(
				(session) => session.close(),
				() => {},
			);
			throw error;
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
		const entry = this.getEntry({ scope, id });
		const session = await entry.capture;
		const artifact = await session.capture({
			timeSeconds,
			previewScale,
			signal,
		});
		if (this.closed || this.sessions.get(id) !== entry) {
			this.runtime.removeArtifact(artifact.uri);
			throw new Error("The HyperFrames render was closed during capture");
		}
		this.retainArtifact({ scope, artifact });
		return artifact;
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
			const ready = await entry.capture;
			if (!ready.keepAlive())
				throw new Error("HyperFrames render session expired");
			const keepAlive = setInterval(() => ready.keepAlive(), 30_000);
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
		return (await this.getEntry({ scope, id }).capture).keepAlive();
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
		await entry.capture.then(
			(session) => session.close(),
			() => {},
		);
		await entry.audio?.catch(() => {});
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		const pending = [...this.sessions.values()];
		this.sessions.clear();
		for (const entry of pending) entry.abort.abort();
		await Promise.all(
			pending.map((entry) =>
				entry.capture.then(
					(session) => session.close(),
					() => {},
				),
			),
		);
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
			void entry.capture.then(
				(session) => {
					if (session.isClosed && this.sessions.get(id) === entry)
						this.sessions.delete(id);
				},
				() => {
					if (this.sessions.get(id) === entry) this.sessions.delete(id);
				},
			);
		}
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
