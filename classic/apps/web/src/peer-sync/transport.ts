/** Outbound-only host transport. It never opens a listener on either computer. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openPeerMessage, sealPeerMessage } from "./crypto";
import type { PeerIdentity } from "./identity";
import type { PeerDevice } from "./types";

const peerSchema = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		name: z.string().max(128),
		publicKey: z.string().max(512),
		lastSeenAt: z.number().finite(),
	})
	.strict();
const envelopeSchema = z
	.object({
		from: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		publicKey: z.string().max(512),
		sealed: z.string().max(500_000),
	})
	.strict();
const messageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("cancel"), id: z.string().uuid() }).strict(),
	z
		.object({
			type: z.literal("request"),
			id: z.string().uuid(),
			operation: z.enum(["manifest", "chunk"]),
			data: z.unknown(),
		})
		.strict(),
	z
		.object({
			type: z.literal("reply"),
			id: z.string().uuid(),
			ok: z.boolean(),
			data: z.unknown().optional(),
			error: z.string().max(500).optional(),
		})
		.strict(),
]);

export class PeerTransport {
	private controller = new AbortController();
	private token = "";
	private owner = "";
	private pending = new Map<
		string,
		{
			peer: string;
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	private requests = new Set<string>();
	private sourceWork = 0;
	private sourceRequests = new Map<string, AbortController>();
	connected = false;
	error: string | null = null;
	constructor(
		private options: {
			url: string;
			identity: PeerIdentity;
			owner: string;
			idToken: string;
			handle: (request: {
				peer: string;
				operation: "manifest" | "chunk";
				data: unknown;
				signal: AbortSignal;
			}) => Promise<unknown>;
			active: () => boolean;
		},
	) {}
	private async http({
		path,
		body,
		signal = this.controller.signal,
	}: {
		path: string;
		body?: unknown;
		signal?: AbortSignal;
	}) {
		const response = await fetch(`${this.options.url}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
		});
		// Relays are external. Bound their response before JSON decoding.
		const reader = response.body?.getReader();
		const parts: Uint8Array[] = [];
		let bytes = 0;
		if (reader)
			try {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					bytes += part.value.length;
					if (bytes > 2_000_000) {
						await reader.cancel();
						throw new Error("Relay response exceeded its bound");
					}
					parts.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
		const raw: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
		if (!response.ok)
			throw new Error(
				z.object({ error: z.string().max(500) }).safeParse(raw).data?.error ||
					"Device relay request failed",
			);
		return raw;
	}
	async connect() {
		const reply = z
			.object({
				token: z.string().max(128),
				owner: z.string().regex(/^[a-f0-9]{64}$/),
				expiresAt: z.number().finite(),
			})
			.strict()
			.parse(
				await this.http({
					path: "/connect",
					body: {
						deviceId: this.options.identity.id,
						name: this.options.identity.name,
						publicKey: this.options.identity.publicKey,
						idToken: this.options.idToken,
					},
				}),
			);
		if (reply.owner !== this.options.owner || reply.expiresAt <= Date.now())
			throw new Error("Relay identity differs from this Legitate account");
		this.token = reply.token;
		this.owner = reply.owner;
		this.connected = true;
		void this.receive();
	}
	async devices(): Promise<PeerDevice[]> {
		return z
			.object({ devices: z.array(peerSchema).max(64) })
			.strict()
			.parse(await this.http({ path: "/devices" })).devices;
	}
	private async send({
		peer,
		publicKey,
		value,
	}: {
		peer: string;
		publicKey: string;
		value: unknown;
	}) {
		this.assertActive();
		const sealed = sealPeerMessage({
			privateKey: this.options.identity.privateKey,
			publicKey,
			owner: this.owner,
			sender: this.options.identity.id,
			recipient: peer,
			value,
		});
		await this.http({ path: "/send", body: { to: peer, sealed } });
	}
	private assertActive() {
		this.controller.signal.throwIfAborted();
		if (!this.options.active()) {
			this.close();
			throw new Error(
				"This device stopped sharing or its authenticated presence expired",
			);
		}
	}
	async request({
		deviceId,
		operation,
		data,
		signal,
		timeoutMs = 30_000,
	}: {
		deviceId: string;
		operation: "manifest" | "chunk";
		data: unknown;
		signal: AbortSignal;
		timeoutMs?: number;
	}): Promise<unknown> {
		this.assertActive();
		if (this.pending.size >= 8)
			throw new Error("Too many outstanding media chunks");
		const peer = (await this.devices()).find(
			(device) => device.id === deviceId,
		);
		if (!peer) throw new Error("Source device is offline");
		const id = randomUUID();
		const cancelled = AbortSignal.any([
			signal,
			this.controller.signal,
			AbortSignal.timeout(timeoutMs),
		]);
		cancelled.throwIfAborted();
		return new Promise((resolve, reject) => {
			const finish = ({
				error,
				result,
			}: {
				error: Error | null;
				result?: unknown;
			}) => {
				if (!this.pending.delete(id)) return;
				cancelled.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve(result);
			};
			const abort = () => {
				const pending = this.pending.has(id);
				finish({
					error: new Error(
						"Media transfer interrupted; retry the same operation to resume",
					),
				});
				if (pending && !this.controller.signal.aborted)
					void this.send({
						peer: peer.id,
						publicKey: peer.publicKey,
						value: { type: "cancel", id },
					}).catch(() => {});
			};
			this.pending.set(id, {
				peer: deviceId,
				resolve: (value) => finish({ error: null, result: value }),
				reject: (error) => finish({ error }),
			});
			cancelled.addEventListener("abort", abort, { once: true });
			void this.send({
				peer: peer.id,
				publicKey: peer.publicKey,
				value: {
					type: "request",
					id,
					operation,
					data,
				},
			}).catch((error) => finish({ error }));
		});
	}
	private async deliver(envelope: z.infer<typeof envelopeSchema>) {
		this.assertActive();
		const message = messageSchema.parse(
			openPeerMessage({
				privateKey: this.options.identity.privateKey,
				publicKey: envelope.publicKey,
				owner: this.owner,
				sender: envelope.from,
				recipient: this.options.identity.id,
				sealed: envelope.sealed,
			}),
		);
		if (message.type === "reply") {
			const pending = this.pending.get(message.id);
			if (pending?.peer === envelope.from) {
				if (message.ok) pending.resolve(message.data);
				else
					pending.reject(
						new Error(
							message.error || "Source device could not provide this file",
						),
					);
			}
			return;
		}
		const key = `${envelope.from}:${message.id}`;
		if (message.type === "cancel") {
			this.sourceRequests.get(key)?.abort();
			// Remember early cancellation too: independent HTTP sends can arrive out
			// of order. A cancelled request may never start source IO afterwards.
			this.requests.add(key);
			if (this.requests.size > 1024)
				this.requests.delete(this.requests.values().next().value!);
			return;
		}
		if (this.requests.has(key) || this.sourceWork >= 8) return;
		this.requests.add(key);
		if (this.requests.size > 1024)
			this.requests.delete(this.requests.values().next().value!);
		this.sourceWork++;
		const sourceController = new AbortController();
		this.sourceRequests.set(key, sourceController);
		try {
			const data = await this.options.handle({
				peer: envelope.from,
				operation: message.operation,
				data: message.data,
				signal: AbortSignal.any([
					this.controller.signal,
					sourceController.signal,
				]),
			});
			this.assertActive();
			await this.send({
				peer: envelope.from,
				publicKey: envelope.publicKey,
				value: {
					type: "reply",
					id: message.id,
					ok: true,
					data,
				},
			});
		} catch {
			if (!this.controller.signal.aborted)
				await this.send({
					peer: envelope.from,
					publicKey: envelope.publicKey,
					value: {
						type: "reply",
						id: message.id,
						ok: false,
						error:
							"Original unavailable, changed, or outside this account/project",
					},
				}).catch(() => {});
		} finally {
			this.sourceRequests.delete(key);
			this.sourceWork--;
		}
	}
	private async receive() {
		try {
			while (!this.controller.signal.aborted) {
				this.assertActive();
				const { messages } = z
					.object({ messages: z.array(envelopeSchema).max(4) })
					.strict()
					.parse(await this.http({ path: "/poll" }));
				for (const envelope of messages)
					void this.deliver(envelope).catch(() => {});
			}
		} catch (error) {
			this.error =
				error instanceof Error
					? error.message
					: "Device connection interrupted";
			this.close();
		}
	}
	close() {
		if (this.controller.signal.aborted) return;
		this.connected = false;
		if (this.token)
			void this.http({
				path: "/disconnect",
				body: {},
				signal: AbortSignal.timeout(2000),
			}).catch(() => {});
		this.controller.abort();
		for (const value of [...this.pending.values()])
			value.reject(
				new Error(
					"Device connection interrupted; resume this operation after reconnecting",
				),
			);
	}
}
