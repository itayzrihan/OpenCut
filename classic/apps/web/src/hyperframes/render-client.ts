/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Internal authenticated transport returns canonical metadata. */
import type {
	HyperframesComposition,
	HyperframesSource,
	HyperframesLiveHandle,
	HyperframesLayerEdits,
} from "./types";
import type { HyperframesRenderSession } from "./render-host";
import type { HyperframesFrameArtifact } from "./capture-session";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 24;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_FILES = 8;
const MAX_LIVE_SOURCES = 4;

/** Derived rendering cache scoped to one active account/project. Original
 * source stays in the canonical document; decoded frames have a bounded LRU.
 */
export class HyperframesRenderClient {
	private readonly pending = new AbortController();
	// Capture is already sequential in each browser. Bound this client's live
	// browsers as well, including when source edits create new fingerprints.
	private renderQueue: Promise<void> = Promise.resolve();
	/** Each displayed occurrence owns a lease, including repeated sources. */
	private readonly liveLeases = new Map<string, Set<object>>();
	/** A live source can also have an effectful occurrence requiring capture. */
	private capturedLiveSourceKey: string | null = null;
	private readonly sessions = new Map<
		string,
		Promise<HyperframesRenderSession>
	>();
	private readonly sourceKeys = new WeakMap<
		HyperframesSource,
		Promise<string>
	>();
	private readonly frames = new Map<string, ImageBitmap>();
	private frameBytes = 0;
	private readonly audioFiles = new Map<string, File | null>();
	private audioBytes = 0;
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;
	private readonly accountId: string | null;
	private readonly onPageHide = (event: PageTransitionEvent) => {
		// A restored back/forward-cache page keeps its live client. A departing
		// document releases browser slots instead of waiting for server expiry.
		if (!event.persisted) this.dispose();
	};

	constructor(private readonly projectId: string) {
		this.accountId =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		if (typeof window !== "undefined")
			window.addEventListener?.("pagehide", this.onPageHide);
		this.timer = setInterval(() => {
			for (const [key, session] of this.sessions)
				void session
					.then(async ({ id }) => {
						const result = await this.request<{ alive: boolean }>({
							action: "keepAlive",
							id,
						});
						if (!result.alive && this.sessions.get(key) === session)
							this.sessions.delete(key);
					})
					.catch(() => {
						if (this.sessions.get(key) === session) this.sessions.delete(key);
					});
		}, 45_000);
	}

	async renderTo({
		composition,
		layerEdits,
		timeSeconds,
		target,
		previewScale = 1,
	}: {
		composition: HyperframesComposition;
		layerEdits?: HyperframesLayerEdits;
		timeSeconds: number;
		target: OffscreenCanvas;
		previewScale?: number;
	}): Promise<void> {
		const render = this.renderQueue.then(() =>
			this.renderFrame({
				composition,
				layerEdits,
				timeSeconds,
				target,
				previewScale,
			}),
		);
		this.renderQueue = render.catch(() => {});
		return render;
	}

	/** Resolve generated duration and verify runtime readiness before import. */
	async prepareSource(
		source: HyperframesSource,
	): Promise<HyperframesRenderSession> {
		this.pending.signal.throwIfAborted();
		const key = await this.sourceKey(source);
		const ready = this.renderQueue.then(() => this.getSession({ key, source }));
		this.renderQueue = ready.then(
			() => {},
			() => {},
		);
		return ready;
	}

	/** Live DOM delivery shares the scoped session and its resource lifetime. */
	async openLivePreview({
		composition,
		layerEdits,
	}: {
		composition: HyperframesComposition;
		layerEdits?: HyperframesLayerEdits;
	}): Promise<HyperframesLiveHandle> {
		const key = await this.visualKey({
			source: composition.source,
			layerEdits,
		});
		const ready = this.renderQueue.then(async () => {
			if (!this.liveLeases.has(key) && this.liveLeases.size >= MAX_LIVE_SOURCES)
				throw new Error("The HyperFrames live preview limit is reached");
			const session = await this.getSession({
				key,
				source: composition.source,
				layerEdits,
			});
			const preview = await this.request<{ url: string }>({
				action: "live",
				id: session.id,
			});
			this.pending.signal.throwIfAborted();
			if (this.capturedLiveSourceKey === key) this.capturedLiveSourceKey = null;
			const lease = {};
			const leases = this.liveLeases.get(key) ?? new Set<object>();
			leases.add(lease);
			this.liveLeases.set(key, leases);
			return {
				...preview,
				release: () => {
					leases.delete(lease);
					if (!leases.size && this.liveLeases.get(key) === leases) {
						this.liveLeases.delete(key);
						if (!this.closed) {
							const trim = this.renderQueue.then(() =>
								this.trimSessions({
									limit: Math.max(2, this.liveLeases.size + 1),
								}),
							);
							this.renderQueue = trim.catch(() => {});
						}
					}
				},
			};
		});
		this.renderQueue = ready.then(
			() => {},
			() => {},
		);
		return ready;
	}

	/** Authenticated derived audio shares the source/resource lifetime of frames. */
	async readAudio(source: HyperframesSource): Promise<File | null> {
		const key = await this.sourceKey(source);
		const ready = this.renderQueue.then(async () => {
			this.pending.signal.throwIfAborted();
			if (this.audioFiles.has(key)) {
				const file = this.audioFiles.get(key) ?? null;
				this.audioFiles.delete(key);
				this.audioFiles.set(key, file);
				return file;
			}
			const session = await this.getSession({ key, source });
			let artifact: HyperframesFrameArtifact | null;
			try {
				artifact = await this.request<HyperframesFrameArtifact | null>({
					action: "audio",
					id: session.id,
				});
			} catch (error) {
				this.sessions.delete(key);
				await this.closeRemote(session.id);
				throw error;
			}
			let file: File | null = null;
			if (artifact) {
				if (
					!Number.isSafeInteger(artifact.byteSize) ||
					artifact.byteSize <= 0 ||
					artifact.byteSize > MAX_AUDIO_BYTES ||
					artifact.mimeType !== "audio/mp4"
				)
					throw new Error("HyperFrames audio artifact is invalid or too large");
				const params = new URLSearchParams({
					projectId: this.projectId,
					id: artifact.id,
				});
				const response = await fetch(`/api/hyperframes?${params}`, {
					headers: this.headers(),
					signal: this.pending.signal,
					cache: "no-store",
				});
				if (!response.ok) throw await responseError(response);
				const blob = await response.blob();
				if (blob.size !== artifact.byteSize || blob.size > MAX_AUDIO_BYTES)
					throw new Error("HyperFrames audio artifact size does not match");
				const digest = await crypto.subtle.digest(
					"SHA-256",
					await blob.arrayBuffer(),
				);
				const hash = [...new Uint8Array(digest)]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("");
				if (hash !== artifact.sha256)
					throw new Error("HyperFrames audio artifact checksum does not match");
				file = new File([blob], `hyperframes-${hash}.m4a`, {
					type: "audio/mp4",
					lastModified: 0,
				});
			}
			this.pending.signal.throwIfAborted();
			while (
				this.audioFiles.size >= MAX_AUDIO_FILES ||
				this.audioBytes + (file?.size ?? 0) > MAX_AUDIO_BYTES
			) {
				const oldest = this.audioFiles.entries().next().value;
				if (!oldest) break;
				this.audioFiles.delete(oldest[0]);
				this.audioBytes -= oldest[1]?.size ?? 0;
			}
			this.audioFiles.set(key, file);
			this.audioBytes += file?.size ?? 0;
			return file;
		});
		this.renderQueue = ready.then(
			() => {},
			() => {},
		);
		return ready;
	}

	private async renderFrame({
		composition,
		layerEdits,
		timeSeconds,
		target,
		previewScale,
	}: {
		composition: HyperframesComposition;
		layerEdits?: HyperframesLayerEdits;
		timeSeconds: number;
		target: OffscreenCanvas;
		previewScale: number;
	}): Promise<void> {
		this.pending.signal.throwIfAborted();
		const key = await this.visualKey({
			source: composition.source,
			layerEdits,
		});
		const frameKey = `${key}:${timeSeconds}:${previewScale}`;
		const cached = this.frames.get(frameKey);
		if (cached) {
			this.drawBitmap({ bitmap: cached, target });
			this.frames.delete(frameKey);
			this.frames.set(frameKey, cached);
			return;
		}
		await this.releaseOtherLiveCapture(key);
		const session = await this.getSession({
			key,
			source: composition.source,
			layerEdits,
		});
		if (this.liveLeases.has(key)) this.capturedLiveSourceKey = key;
		let artifact: HyperframesFrameArtifact;
		try {
			artifact = await this.request<HyperframesFrameArtifact>({
				action: "capture",
				id: session.id,
				timeSeconds,
				previewScale,
			});
		} catch (error) {
			// A timeout or idle expiry closes the host session. The next requested
			// frame must open a fresh one instead of reusing a poisoned handle.
			this.sessions.delete(key);
			await this.closeRemote(session.id);
			throw error;
		}
		const params = new URLSearchParams({
			projectId: this.projectId,
			id: artifact.id,
		});
		const response = await fetch(`/api/hyperframes?${params}`, {
			headers: this.headers(),
			signal: this.pending.signal,
			cache: "no-store",
		});
		if (!response.ok) throw await responseError(response);
		const bitmap = await createImageBitmap(await response.blob());
		let retained = false;
		try {
			this.drawBitmap({ bitmap, target });
			const bytes = bitmap.width * bitmap.height * 4;
			if (bytes > 0 && bytes <= MAX_FRAME_BYTES) {
				while (
					this.frames.size >= MAX_FRAMES ||
					this.frameBytes + bytes > MAX_FRAME_BYTES
				) {
					const oldest = this.frames.entries().next().value;
					if (!oldest) break;
					this.frames.delete(oldest[0]);
					this.frameBytes -= oldest[1].width * oldest[1].height * 4;
					oldest[1].close();
				}
				this.frames.set(frameKey, bitmap);
				this.frameBytes += bytes;
				retained = true;
			}
		} finally {
			if (!retained) bitmap.close();
		}
	}

	private drawBitmap({
		bitmap,
		target,
	}: {
		bitmap: ImageBitmap;
		target: OffscreenCanvas;
	}): void {
		this.pending.signal.throwIfAborted();
		const context = target.getContext("2d");
		if (!context) throw new Error("HyperFrames frame target is unavailable");
		context.clearRect(0, 0, target.width, target.height);
		context.drawImage(bitmap, 0, 0, target.width, target.height);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (typeof window !== "undefined")
			window.removeEventListener?.("pagehide", this.onPageHide);
		clearInterval(this.timer);
		this.pending.abort();
		for (const session of this.sessions.values())
			void session.then(
				({ id }) => this.closeRemote(id),
				() => {},
			);
		this.sessions.clear();
		this.liveLeases.clear();
		this.capturedLiveSourceKey = null;
		for (const bitmap of this.frames.values()) bitmap.close();
		this.frames.clear();
		this.frameBytes = 0;
		this.audioFiles.clear();
		this.audioBytes = 0;
	}

	private sourceKey(source: HyperframesSource): Promise<string> {
		let key = this.sourceKeys.get(source);
		if (!key) {
			key = crypto.subtle
				.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)))
				.then((digest) =>
					[...new Uint8Array(digest)]
						.map((byte) => byte.toString(16).padStart(2, "0"))
						.join(""),
				);
			this.sourceKeys.set(source, key);
		}
		return key;
	}

	private async visualKey({
		source,
		layerEdits,
	}: {
		source: HyperframesSource;
		layerEdits?: HyperframesLayerEdits;
	}): Promise<string> {
		const sourceKey = await this.sourceKey(source);
		if (!layerEdits) return sourceKey;
		const hash = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(layerEdits)),
		);
		return `${sourceKey}:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	}

	private async getSession({
		key,
		source,
		layerEdits,
	}: {
		key: string;
		source: HyperframesSource;
		layerEdits?: HyperframesLayerEdits;
	}): Promise<HyperframesRenderSession> {
		this.pending.signal.throwIfAborted();
		let session = this.sessions.get(key);
		if (session) {
			this.sessions.delete(key);
			this.sessions.set(key, session);
		}
		if (!session) {
			// One capture slot alongside displayed sources; native-only/export
			// rendering retains its existing two-entry LRU. Live entries hold no
			// headless browser after host promotion.
			await this.trimSessions({
				limit: Math.max(2, this.liveLeases.size + 1) - 1,
			});
			this.pending.signal.throwIfAborted();
			session = this.request<HyperframesRenderSession>({
				action: "open",
				source,
				...(layerEdits ? { layerEdits } : {}),
			}).then(async (result) => {
				if (this.closed) {
					await this.closeRemote(result.id);
					throw new Error("The project render was closed");
				}
				return result;
			});
			this.sessions.set(key, session);
			const pending = session;
			void session.catch(() => {
				if (this.sessions.get(key) === pending) this.sessions.delete(key);
			});
		}
		return session;
	}

	private async trimSessions({ limit }: { limit: number }): Promise<void> {
		while (this.sessions.size > limit) {
			const oldest = [...this.sessions.entries()].find(
				([key]) => !this.liveLeases.has(key),
			);
			if (!oldest) break;
			this.sessions.delete(oldest[0]);
			await oldest[1].then(
				({ id }) => this.closeRemote(id),
				() => {},
			);
		}
	}

	/** Retain one warm screenshot browser among pinned live sources. Without
	 * this, effectful copies of four live sources could occupy every browser
	 * and prevent an audio probe or another capture from starting. Delivery
	 * URLs and existing iframes survive the host's promotion unchanged. */
	private async releaseOtherLiveCapture(nextKey: string): Promise<void> {
		const previous = this.capturedLiveSourceKey;
		if (!previous || previous === nextKey) return;
		this.capturedLiveSourceKey = null;
		if (!this.liveLeases.has(previous)) return;
		const session = this.sessions.get(previous);
		if (session) await this.request({ action: "live", id: (await session).id });
	}

	private headers(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			...(this.accountId ? { "X-OpenCut-Account": this.accountId } : {}),
		};
	}

	private async request<T>(input: Record<string, unknown>): Promise<T> {
		const response = await fetch("/api/hyperframes", {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ ...input, projectId: this.projectId }),
			signal: this.pending.signal,
			cache: "no-store",
		});
		if (!response.ok) throw await responseError(response);
		return (await response.json()) as T;
	}

	private async closeRemote(id: string): Promise<void> {
		await fetch("/api/hyperframes", {
			method: "POST",
			headers: this.headers(),
			keepalive: true,
			body: JSON.stringify({ action: "close", projectId: this.projectId, id }),
		}).catch(() => {});
	}
}

async function responseError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => null)) as {
		error?: unknown;
	} | null;
	return new Error(
		typeof body?.error === "string"
			? body.error
			: `HyperFrames render failed (${response.status})`,
	);
}
