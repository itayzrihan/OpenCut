/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Internal authenticated transport returns canonical metadata. */
import type { HyperframesComposition, HyperframesSource } from "./types";
import type { HyperframesRenderSession } from "./render-host";
import type { HyperframesFrameArtifact } from "./capture-session";

/** Derived rendering cache scoped to one active account/project. Original
 * source stays in the canonical document; bitmaps live only for a draw call.
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
	private readonly timer: ReturnType<typeof setInterval>;
	private closed = false;
	private readonly accountId: string | null;

	constructor(private readonly projectId: string) {
		this.accountId =
			typeof window === "undefined" ? null : window.__opencutAccountId;
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
	}: {
		composition: HyperframesComposition;
		timeSeconds: number;
		target: OffscreenCanvas;
	}): Promise<void> {
		const render = this.renderQueue.then(() =>
			this.renderFrame({ composition, timeSeconds, target }),
		);
		this.renderQueue = render.catch(() => {});
		return render;
	}

	private async renderFrame({
		composition,
		timeSeconds,
		target,
	}: {
		composition: HyperframesComposition;
		timeSeconds: number;
		target: OffscreenCanvas;
	}): Promise<void> {
		this.pending.signal.throwIfAborted();
		const key = await this.sourceKey(composition.source);
		const session = await this.getSession({ key, source: composition.source });
		let artifact: HyperframesFrameArtifact;
		try {
			artifact = await this.request<HyperframesFrameArtifact>({
				action: "capture",
				id: session.id,
				timeSeconds,
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
		try {
			this.pending.signal.throwIfAborted();
			const context = target.getContext("2d");
			if (!context) throw new Error("HyperFrames frame target is unavailable");
			context.clearRect(0, 0, target.width, target.height);
			context.drawImage(bitmap, 0, 0, target.width, target.height);
		} finally {
			bitmap.close();
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		this.pending.abort();
		for (const session of this.sessions.values())
			void session.then(
				({ id }) => this.closeRemote(id),
				() => {},
			);
		this.sessions.clear();
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
