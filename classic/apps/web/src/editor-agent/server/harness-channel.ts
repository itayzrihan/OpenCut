import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { HarnessCall, HarnessEvent } from "../harness-protocol";

interface Pending {
	id: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** In-flight transport mailboxes only. No editor state or recoverable run is
 * stored here; canonical checkpoints and receipts remain in Rust. */
export class HarnessChannel {
	readonly id = randomUUID();
	readonly token = randomBytes(32).toString("hex");
	private pending: Pending | undefined;
	private closed = false;
	readonly accountId: string;
	readonly projectId: string;
	private readonly send: (event: HarnessEvent) => void;
	private readonly signal: AbortSignal;
	private readonly timeoutMs: number;
	constructor({
		accountId,
		projectId,
		send,
		signal,
		timeoutMs = 15 * 60_000,
	}: {
		accountId: string;
		projectId: string;
		send: (event: HarnessEvent) => void;
		signal: AbortSignal;
		timeoutMs?: number;
	}) {
		this.accountId = accountId;
		this.projectId = projectId;
		this.send = send;
		this.signal = signal;
		this.timeoutMs = timeoutMs;
	}
	call({
		operation,
		round,
	}: {
		operation: HarnessCall["operation"];
		round: number;
	}): Promise<unknown> {
		this.signal.throwIfAborted();
		if (this.closed || this.pending)
			return Promise.reject(new Error("Harness channel is unavailable"));
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pending = undefined;
				this.closed = true;
				reject(new Error("Editor did not acknowledge the harness callback"));
			}, this.timeoutMs);
			timer.unref?.();
			this.pending = { id, resolve, reject, timer };
			try {
				this.send({ type: "call", callId: id, operation, round });
			} catch (error) {
				this.close(
					error instanceof Error ? error : new Error("Harness stream closed"),
				);
			}
		});
	}
	reply({
		accountId,
		projectId,
		token,
		callId,
		result,
		error,
	}: {
		accountId: string;
		projectId: string;
		token: string;
		callId: string;
		result?: unknown;
		error?: string;
	}): void {
		this.signal.throwIfAborted();
		if (
			accountId !== this.accountId ||
			projectId !== this.projectId ||
			token.length !== this.token.length ||
			!timingSafeEqual(Buffer.from(token), Buffer.from(this.token))
		)
			throw new Error("Harness callback belongs to another editing scope");
		const pending = this.pending;
		if (this.closed || !pending || pending.id !== callId)
			throw new Error("Harness callback is stale or already acknowledged");
		this.pending = undefined;
		clearTimeout(pending.timer);
		if (error) {
			this.closed = true;
			pending.reject(new Error(error));
		} else pending.resolve(result);
	}
	close(error = new Error("Harness channel closed")) {
		this.closed = true;
		if (this.pending) {
			clearTimeout(this.pending.timer);
			this.pending.reject(error);
			this.pending = undefined;
		}
	}
}
