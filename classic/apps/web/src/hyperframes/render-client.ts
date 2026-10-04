/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Internal authenticated transport returns canonical metadata. */
import type { HyperframesComposition, HyperframesSource } from "./types";
import type { HyperframesRenderSession } from "./render-host";
import type { HyperframesFrameArtifact } from "./capture-session";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 24;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_FILES = 8;

/** Derived rendering cache scoped to one active account/project. Original
 * source stays in the canonical document; decoded frames have a bounded LRU.
 */
export class HyperframesRenderClient {
	private readonly pending = new AbortController();
	// Capture is already sequential in each browser. Bound this client's live
	// browsers as well, including when source edits create new fingerprints.
	private renderQueue: Promise<void> = Promise.resolve();
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
		timeSeconds,
		target,
		previewScale = 1,
	}: {
		composition: HyperframesComposition;
		timeSeconds: number;
		target: OffscreenCanvas;
		previewScale?: number;
	}): Promise<void> {
		const render = this.renderQueue.then(() =>
			this.renderFrame({ composition, timeSeconds, target, previewScale }),
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
		timeSeconds,
		target,
		previewScale,
	}: {
		composition: HyperframesComposition;
		timeSeconds: number;
		target: OffscreenCanvas;
		previewScale: number;
	}): Promise<void> {
		this.pending.signal.throwIfAborted();
		const key = await this.sourceKey(composition.source);
		const frameKey = `${key}:${timeSeconds}:${previewScale}`;
		const cached = this.frames.get(frameKey);
		if (cached) {
			this.drawBitmap({ bitmap: cached, target });
			this.frames.delete(frameKey);
			this.frames.set(frameKey, cached);
			return;
		}
		const session = await this.getSession({ key, source: composition.source });
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

	private async getSession({
		key,
		source,
	}: {
		key: string;
		source: HyperframesSource;
	}): Promise<HyperframesRenderSession> {
		this.pending.signal.throwIfAborted();
		let session = this.sessions.get(key);
		if (session) {
			this.sessions.delete(key);
			this.sessions.set(key, session);
		}
		if (!session) {
			while (this.sessions.size >= 2) {
				const oldest = this.sessions.entries().next().value;
				if (!oldest) break;
				this.sessions.delete(oldest[0]);
				await oldest[1].then(
					({ id }) => this.closeRemote(id),
					() => {},
				);
			}
			this.pending.signal.throwIfAborted();
			session = this.request<HyperframesRenderSession>({
				action: "open",
				source,
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
