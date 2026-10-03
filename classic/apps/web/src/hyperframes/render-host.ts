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
import type { HyperframesSource } from "./types";

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
}
interface Entry {
	scope: HyperframesRenderScope;
	abort: AbortController;
	capture: Promise<HyperframesCaptureSession>;
}
const MAX_ARTIFACT_HANDLES = 2048;

export class HyperframesRenderHost {
	private readonly previews = new HyperframesPreviewHost();
	private readonly sessions = new Map<string, Entry>();
	private readonly artifacts = new Map<
		string,
		{ scope: HyperframesRenderScope; artifact: HyperframesFrameArtifact }
	>();
	private closed = false;
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
		const entry = { scope: { ...scope }, abort, capture };
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
		signal,
	}: {
		scope: HyperframesRenderScope;
		id: string;
		timeSeconds: number;
		signal?: AbortSignal;
	}): Promise<HyperframesFrameArtifact> {
		const entry = this.getEntry({ scope, id });
		const session = await entry.capture;
		const artifact = await session.capture({ timeSeconds, signal });
		if (this.closed || this.sessions.get(id) !== entry) {
			this.runtime.removeArtifact(artifact.uri);
			throw new Error("The HyperFrames render was closed during capture");
		}
		this.prune();
		while (this.artifacts.size >= MAX_ARTIFACT_HANDLES) {
			const oldest = this.artifacts.keys().next().value;
			if (!oldest) break;
			this.artifacts.delete(oldest);
			this.runtime.removeArtifact(oldest);
		}
		this.artifacts.set(artifact.id, { scope: { ...scope }, artifact });
		return artifact;
	}

	readArtifact({ scope, id }: { scope: HyperframesRenderScope; id: string }): {
		bytes: Uint8Array;
		artifact: HyperframesFrameArtifact;
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
