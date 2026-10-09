import { z } from "zod";
import { batchWriteHeaders } from "@/batch/write-token";
import { bindEditorWriteAuthority } from "./write-authority";
import type { CanonicalHistoryArchive } from "@/core/canonical-classic-session";

export interface EditorSessionBundle {
	archive: CanonicalHistoryArchive;
	agentCheckpoint: string | null;
	thumbnail?: string;
	conversation?: import("@/core/agent-protocol").EditingConversationArchive;
	artifacts?: import("@/core/agent-protocol").EditingArtifactArchive;
}
const leaseSchema = z.object({
	sessionId: z.string(),
	generation: z.number().int().nonnegative(),
	expiresAtMs: z.number().int().nonnegative(),
});
const viewSchema = z.object({
	storageRevision: z.number().int().nonnegative(),
	generation: z.number().int().nonnegative(),
	lease: leaseSchema.nullable(),
	saved: z
		.object({
			editorRevision: z.number().int().nonnegative(),
			project: z.unknown(),
			bundle: z.object({
				archive: z.unknown(),
				agentCheckpoint: z.string().nullable(),
				thumbnail: z.string().optional(),
				conversation: z.unknown().optional(),
				artifacts: z.unknown().optional(),
			}),
		})
		.nullable(),
	legacyProject: z.unknown(),
	legacyHistory: z.unknown(),
});
export type EditorSessionView = z.infer<typeof viewSchema>;
const receiptSchema = z.object({
	storageRevision: z.number().int().positive(),
	editorRevision: z.number().int().nonnegative(),
	requestId: z.string(),
});
export class EditorSessionFailure extends Error {
	readonly definitive: boolean;
	constructor({
		message,
		definitive,
	}: {
		message: string;
		definitive: boolean;
	}) {
		super(message);
		this.definitive = definitive;
	}
}
type Exchange = (request: Record<string, unknown>) => Promise<unknown>;

/** IO ordering and acknowledgements only. Rust owns the lease/fence, canonical
 * archive validation, optimistic saves and idempotency decisions. */
export class EditorSessionClient {
	private lease: z.infer<typeof leaseSchema> | null = null;
	private storageRevision = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private pending: Record<string, unknown> | null = null;
	private readonly exchange: Exchange;
	private readonly sessionId: string;
	private readonly accountId: string;
	private readonly projectId: string;
	private unbindAuthority: (() => void) | null = null;
	private disposed = false;
	private leaseFailure: Error | null = null;
	constructor({
		accountId,
		projectId,
		sessionId = crypto.randomUUID(),
		exchange,
		requestTimeoutMs,
	}: {
		accountId: string;
		projectId: string;
		sessionId?: string;
		exchange?: Exchange;
		requestTimeoutMs?: number;
	}) {
		if (
			requestTimeoutMs !== undefined &&
			(!Number.isInteger(requestTimeoutMs) ||
				requestTimeoutMs < 1 ||
				requestTimeoutMs > 120_000)
		)
			throw new RangeError(
				"Editor storage timeout must be between 1 and 120000 ms",
			);
		this.sessionId = sessionId;
		this.accountId = accountId;
		this.projectId = projectId;
		this.exchange =
			exchange ??
			(async (request) => {
				const controller = new AbortController();
				// Reads/acquisitions return the full archive too. Large project opens
				// need the same bounded window as saves; renew/release stay short.
				const transfersArchive = ["read", "acquire", "commit"].includes(
					String(request.type),
				);
				const timeoutMs =
					requestTimeoutMs ?? (transfersArchive ? 120_000 : 30_000);
				const timeout = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const assertAccount = () => {
						if ((window.__opencutAccountId ?? "local") !== accountId)
							throw new EditorSessionFailure({
								message: "The active account changed",
								definitive: true,
							});
					};
					assertAccount();
					const response = await fetch("/api/editor-session", {
						signal: controller.signal,
						method: "POST",
						credentials: "same-origin",
						cache: "no-store",
						headers: {
							"Content-Type": "application/json",
							"X-OpenCut-Account": accountId,
							...batchWriteHeaders(),
						},
						body: JSON.stringify({ projectId, request }),
					});
					assertAccount();
					const data: unknown = await response.json();
					assertAccount();
					if (!response.ok) {
						const failure = z
							.object({ error: z.string(), definitive: z.boolean() })
							.safeParse(data).data;
						throw new EditorSessionFailure({
							message: failure?.error ?? "Editor session request failed",
							definitive: failure?.definitive ?? false,
						});
					}
					return data;
				} catch (error) {
					if (error instanceof EditorSessionFailure && error.definitive)
						throw error;
					if (controller.signal.aborted)
						throw new EditorSessionFailure({
							message:
								request.type === "commit"
									? "Editor storage timed out; the save outcome is unknown. Retry the pending save before further changes."
									: "Editor storage timed out. Please retry.",
							definitive: false,
						});
					throw error;
				} finally {
					clearTimeout(timeout);
				}
			});
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue
			.catch(() => undefined)
			.then(() => {
				this.assertLive();
				return operation();
			});
		this.queue = next;
		return next;
	}
	read(): Promise<EditorSessionView> {
		return this.serialize(async () =>
			viewSchema.parse(await this.exchange({ type: "read" })),
		);
	}
	isCurrentOwner(view: EditorSessionView): boolean {
		return view.lease?.sessionId === this.sessionId;
	}
	acquire({
		expectedGeneration,
		takeOver = false,
	}: {
		expectedGeneration: number;
		takeOver?: boolean;
	}): Promise<EditorSessionView> {
		return this.serialize(async () => {
			if (this.pending)
				throw new Error(
					"Reconcile the pending save before transferring ownership",
				);
			this.lease = null;
			const view = viewSchema.parse(
				await this.exchange({
					type: "acquire",
					sessionId: this.sessionId,
					expectedGeneration,
					takeOver,
				}),
			);
			if (!view.lease || view.lease.sessionId !== this.sessionId)
				throw new Error("The host did not grant this editor ownership");
			this.assertLive();
			this.lease = view.lease;
			this.leaseFailure = null;
			this.unbindAuthority?.();
			this.unbindAuthority = bindEditorWriteAuthority({
				accountId: this.accountId,
				projectId: this.projectId,
				read: () => (this.disposed ? null : this.lease),
			});
			this.storageRevision = view.storageRevision;
			return view;
		});
	}
	renew(): Promise<void> {
		return this.serialize(() => this.renewLease());
	}
	private async renewLease(): Promise<void> {
		const lease = this.requireLease();
		try {
			const result = z.object({ lease: leaseSchema }).parse(
				await this.exchange({
					type: "renew",
					sessionId: this.sessionId,
					generation: lease.generation,
				}),
			);
			if (
				result.lease.sessionId !== this.sessionId ||
				result.lease.generation !== lease.generation
			)
				throw new Error("Unexpected editor ownership acknowledgement");
			this.assertLive();
			this.lease = result.lease;
		} catch (error) {
			if (error instanceof EditorSessionFailure && error.definitive) {
				this.lease = null;
				this.leaseFailure = error;
			}
			throw error;
		}
	}
	private async ensureFreshLease(): Promise<void> {
		// Refresh before writing after sleep or a long queue. The host resumes
		// only an unchanged fence; this never acquires or takes over a project.
		if (this.requireLease().expiresAtMs <= Date.now() + 30_000)
			await this.renewLease();
	}
	/** A definitive acquisition conflict is observable, not permission to retry
	 * takeover against a newer owner. Preserve the server's fence and read the
	 * latest saved version for the read-only recovery UI. Ambiguous transport
	 * failures still propagate and never redispatch an acquisition.
	 */
	async acquireOrObserve(input: {
		expectedGeneration: number;
		takeOver?: boolean;
	}): Promise<{ view: EditorSessionView; acquired: boolean }> {
		try {
			return { view: await this.acquire(input), acquired: true };
		} catch (error) {
			if (!(error instanceof EditorSessionFailure) || !error.definitive)
				throw error;
			return { view: await this.read(), acquired: false };
		}
	}
	/** Capture only after an older uncertain save has been reconciled. No later
	 * state can replace the original request identity after a lost response. */
	save(capture: () => EditorSessionBundle): Promise<void> {
		return this.serialize(async () => {
			await this.ensureFreshLease();
			if (this.pending) await this.commitPending();
			const lease = this.requireLease();
			this.pending = {
				type: "commit",
				sessionId: this.sessionId,
				generation: lease.generation,
				expectedStorageRevision: this.storageRevision,
				requestId: crypto.randomUUID(),
				bundle: structuredClone(capture()),
			};
			await this.commitPending();
		});
	}
	private async commitPending(): Promise<void> {
		const pending = this.pending;
		if (!pending) return;
		try {
			const receipt = receiptSchema.parse(await this.exchange(pending));
			if (
				receipt.requestId !== pending.requestId ||
				receipt.storageRevision !== Number(pending.expectedStorageRevision) + 1
			)
				throw new Error(
					"Unexpected save acknowledgement; reconcile before continuing",
				);
			this.storageRevision = receipt.storageRevision;
			this.pending = null;
		} catch (error) {
			if (error instanceof EditorSessionFailure && error.definitive) {
				this.pending = null;
				this.lease = null;
				this.leaseFailure = error;
			}
			throw error;
		}
	}
	release(): Promise<void> {
		return this.serialize(async () => {
			await this.ensureFreshLease();
			if (this.pending) await this.commitPending();
			const lease = this.requireLease();
			await this.exchange({
				type: "release",
				sessionId: this.sessionId,
				generation: lease.generation,
			});
			this.lease = null;
			this.unbindAuthority?.();
			this.unbindAuthority = null;
		});
	}
	dispose(): void {
		this.disposed = true;
		this.lease = null;
		this.unbindAuthority?.();
		this.unbindAuthority = null;
	}
	private assertLive() {
		if (this.disposed)
			throw new EditorSessionFailure({
				message: "Editor session was closed",
				definitive: true,
			});
	}
	private requireLease() {
		this.assertLive();
		if (!this.lease)
			throw (
				this.leaseFailure ??
				new Error("Reopen the latest project to acquire editor ownership")
			);
		return this.lease;
	}
}
