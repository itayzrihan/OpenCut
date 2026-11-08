/** Ephemeral rendezvous and bounded encrypted-message relay. No media is stored.
 * The verified issuer+subject, never a supplied account ID, selects the mailbox.
 */
import { createHash, randomBytes, createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.legitate.com";
const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));
const safeId = /^[a-zA-Z0-9_-]{1,160}$/;
const maxBody = 512 * 1024;
export async function verifyRelayIdentity(token, key = jwks) {
	const { payload } = await jwtVerify(token, key, {
		issuer,
		audience: "opencut-local",
		algorithms: ["RS256", "ES256", "PS256"],
		requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
		clockTolerance: 15,
	});
	if (
		typeof payload.sub !== "string" ||
		!payload.sub ||
		(payload.azp !== undefined && payload.azp !== "opencut-local") ||
		(Array.isArray(payload.aud) &&
			payload.aud.length > 1 &&
			payload.azp !== "opencut-local")
	)
		throw new Error("Invalid Legitate identity");
	return {
		owner: createHash("sha256")
			.update(`${issuer}\0${payload.sub}`)
			.digest("hex"),
		expiresAt: payload.exp * 1000,
	};
}

export function createPeerRelay({
	verifyIdentity = verifyRelayIdentity,
	now = Date.now,
} = {}) {
	const sessions = new Map();
	let queuedBytes = 0;
	let connecting = 0;
	let reading = 0;
	const onlineMs = 45_000;
	const send = (res, status, value) => {
		if (!res.destroyed && !res.writableEnded) {
			res.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(JSON.stringify(value));
		}
	};
	const live = (session) =>
		session.expiresAt > now() && now() - session.seenAt < onlineMs;
	function remove(token) {
		const session = sessions.get(token);
		if (session)
			for (const message of session.queue) queuedBytes -= message.sealed.length;
		if (session?.waiting) {
			clearTimeout(session.waiting.timer);
			send(session.waiting.res, 401, { error: "Peer session ended" });
		}
		sessions.delete(token);
	}
	const timer = setInterval(() => {
		for (const [key, value] of sessions) if (!live(value)) remove(key);
	}, 10_000);
	timer.unref();
	async function body(req) {
		if (reading >= 32) throw new Error("Relay request limit reached");
		reading++;
		try {
			let size = 0;
			const parts = [];
			for await (const part of req) {
				size += part.length;
				if (size > maxBody) throw new Error("Message too large");
				parts.push(part);
			}
			return JSON.parse(Buffer.concat(parts).toString("utf8"));
		} finally {
			reading--;
		}
	}
	const server = createServer(async (req, res) => {
		try {
			const path = new URL(req.url, "http://relay.invalid").pathname;
			if (req.method === "GET" && path === "/health")
				return send(res, 200, { service: "opencut-peer-relay", version: 1 });
			if (req.method === "POST" && path === "/connect") {
				if (sessions.size >= 256 || connecting >= 16)
					return send(res, 503, { error: "Relay is busy" });
				const input = await body(req);
				if (
					!safeId.test(input.deviceId) ||
					typeof input.name !== "string" ||
					!input.name.trim() ||
					Buffer.byteLength(input.name) > 128 ||
					/[\x00-\x1f\x7f]/.test(input.name) ||
					typeof input.publicKey !== "string" ||
					input.publicKey.length > 512 ||
					createPublicKey(input.publicKey).asymmetricKeyType !== "x25519" ||
					typeof input.idToken !== "string" ||
					input.idToken.length > 32768
				)
					throw new Error("Invalid device");
				connecting++;
				let identity;
				try {
					identity = await verifyIdentity(input.idToken);
				} finally {
					connecting--;
				}
				if (
					typeof identity.owner !== "string" ||
					!identity.owner ||
					!Number.isFinite(identity.expiresAt) ||
					identity.expiresAt <= now()
				)
					throw new Error("Expired identity");
				const owned = [...sessions].filter(
					([, s]) => s.owner === identity.owner && live(s),
				);
				if (
					owned.length >= 64 &&
					!owned.some(([, s]) => s.id === input.deviceId)
				)
					throw new Error("Too many devices");
				for (const [key, s] of owned)
					if (s.id === input.deviceId) {
						if (s.publicKey !== input.publicKey)
							throw new Error("Device identity changed");
						remove(key);
					}
				const token = randomBytes(32).toString("base64url");
				const expiresAt = Math.min(
					identity.expiresAt,
					now() + 8 * 60 * 60 * 1000,
				);
				sessions.set(token, {
					owner: identity.owner,
					id: input.deviceId,
					name: input.name,
					publicKey: input.publicKey,
					expiresAt,
					seenAt: now(),
					queue: [],
					waiting: null,
				});
				return send(res, 200, { token, expiresAt, owner: identity.owner });
			}
			const token = req.headers.authorization?.replace(/^Bearer /, "");
			const session = sessions.get(token);
			if (!session || !live(session))
				return send(res, 401, {
					error: "Sign in to Legitate again to reconnect this device",
				});
			session.seenAt = now();
			if (req.method === "GET" && path === "/devices") {
				return send(res, 200, {
					devices: [...sessions.values()]
						.filter(
							(s) =>
								s.owner === session.owner && s.id !== session.id && live(s),
						)
						.map((s) => ({
							id: s.id,
							name: s.name,
							publicKey: s.publicKey,
							lastSeenAt: s.seenAt,
						})),
				});
			}
			if (req.method === "POST" && path === "/disconnect") {
				remove(token);
				return send(res, 200, { ok: true });
			}
			if (req.method === "POST" && path === "/send") {
				const message = await body(req);
				if (
					!safeId.test(message.to) ||
					typeof message.sealed !== "string" ||
					message.sealed.length > 500_000
				)
					throw new Error("Invalid encrypted message");
				const peer = [...sessions.values()].find(
					(s) => s.id === message.to && s.owner === session.owner && live(s),
				);
				if (!peer) return send(res, 404, { error: "Source device is offline" });
				// The sender and public key are supplied by the authenticated relay,
				// never by fields in an untrusted message body.
				const envelope = {
					from: session.id,
					publicKey: session.publicKey,
					sealed: message.sealed,
				};
				if (peer.waiting) {
					const waiting = peer.waiting;
					peer.waiting = null;
					clearTimeout(waiting.timer);
					send(waiting.res, 200, { messages: [envelope] });
				} else {
					if (
						peer.queue.length >= 16 ||
						queuedBytes + envelope.sealed.length > 64 * 1024 * 1024
					)
						return send(res, 429, { error: "Peer mailbox is full" });
					peer.queue.push(envelope);
					queuedBytes += envelope.sealed.length;
				}
				return send(res, 200, { ok: true });
			}
			if (req.method === "GET" && path === "/poll") {
				if (session.queue.length) {
					const messages = session.queue.splice(0, 4);
					for (const message of messages) queuedBytes -= message.sealed.length;
					return send(res, 200, { messages });
				}
				if (session.waiting)
					return send(res, 409, {
						error: "Only one receiver is allowed per device",
					});
				const waiting = {
					res,
					timer: setTimeout(() => {
						if (session.waiting === waiting) session.waiting = null;
						send(res, 200, { messages: [] });
					}, 15_000),
				};
				session.waiting = waiting;
				res.on("close", () => {
					clearTimeout(waiting.timer);
					if (session.waiting === waiting) session.waiting = null;
				});
				return;
			}
			send(res, 404, { error: "Unknown relay operation" });
		} catch {
			send(res, 400, { error: "Peer request rejected" });
		}
	});
	server.headersTimeout = 20_000;
	server.requestTimeout = 30_000;
	server.maxConnections = 256;
	server.on("close", () => {
		clearInterval(timer);
		for (const token of sessions.keys()) remove(token);
	});
	return server;
}
