import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { createPeerRelay, verifyRelayIdentity } from "./relay.mjs";
import { openPeerMessage, sealPeerMessage } from "./crypto";

function keys(id: string) {
	const k = generateKeyPairSync("x25519");
	return {
		id,
		name: id,
		publicKey: k.publicKey.export({ type: "spki", format: "pem" }).toString(),
		privateKey: k.privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
	};
}
const owner = createHash("sha256").update("alice").digest("hex");
test("authenticates encrypted chunk bytes, account, sender and recipient", () => {
	const alice = keys("alice"),
		laptop = keys("laptop");
	const value = { data: Buffer.alloc(256 * 1024, 73).toString("base64") };
	const sealed = sealPeerMessage({
		...alice,
		publicKey: laptop.publicKey,
		owner,
		sender: alice.id,
		recipient: laptop.id,
		value,
	});
	const input = {
		...laptop,
		publicKey: alice.publicKey,
		owner,
		sender: alice.id,
		recipient: laptop.id,
		sealed,
	};
	expect(openPeerMessage(input)).toEqual(value);
	expect(sealed).not.toContain(value.data.slice(0, 64));
	for (const change of [
		{ owner: "another-user" },
		{ sender: "forged" },
		{ recipient: "other-device" },
	])
		expect(() => openPeerMessage({ ...input, ...change })).toThrow();
	const corrupt = Buffer.from(sealed, "base64");
	corrupt[corrupt.length - 1] ^= 1;
	expect(() =>
		openPeerMessage({ ...input, sealed: corrupt.toString("base64") }),
	).toThrow();
});

test("relay identity requires signed Legitate issuer, audience and expiry", async () => {
	const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	async function token(
		options: {
			issuer?: string;
			audience?: string | string[];
			expiry?: number;
			azp?: string;
		} = {},
	) {
		return new SignJWT(options.azp ? { azp: options.azp } : {})
			.setProtectedHeader({ alg: "ES256" })
			.setIssuer(options.issuer ?? "https://auth.legitate.com")
			.setAudience(options.audience ?? "opencut-local")
			.setSubject("alice")
			.setIssuedAt()
			.setExpirationTime(options.expiry ?? Math.floor(Date.now() / 1000) + 3600)
			.sign(k.privateKey);
	}
	expect((await verifyRelayIdentity(await token(), k.publicKey)).owner).toBe(
		createHash("sha256")
			.update("https://auth.legitate.com\0alice")
			.digest("hex"),
	);
	for (const bad of [
		{ issuer: "https://attacker.invalid" },
		{ audience: "other-app" },
		{ expiry: Math.floor(Date.now() / 1000) - 60 },
		{ azp: "other-app" },
		{ audience: ["opencut-local", "other-app"] },
	])
		await expect(
			verifyRelayIdentity(await token(bad), k.publicKey),
		).rejects.toThrow();
});

test("live relay isolates accounts and supplies authentic sender IDs", async () => {
	const relay = createPeerRelay({
		verifyIdentity: async (token) => {
			if (!["alice", "bob"].includes(token)) throw new Error("bad proof");
			return { owner: token, expiresAt: Date.now() + 60_000 };
		},
	});
	await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
	const port = (relay.address() as { port: number }).port,
		url = `http://127.0.0.1:${port}`;
	const a = keys("desktop"),
		b = keys("laptop"),
		c = keys("bob-device");
	const connect = async ({
		device,
		token,
	}: {
		device: ReturnType<typeof keys>;
		token: string;
	}) => {
		const response = await fetch(`${url}/connect`, {
			method: "POST",
			body: JSON.stringify({
				deviceId: device.id,
				name: device.name,
				publicKey: device.publicKey,
				idToken: token,
			}),
		});
		return { response, data: (await response.json()) as { token: string } };
	};
	try {
		const alice = await connect({ device: a, token: "alice" }),
			laptop = await connect({ device: b, token: "alice" });
		await connect({ device: c, token: "bob" });
		expect(alice.response.status).toBe(200);
		expect(
			(await connect({ device: keys("invalid"), token: "unverified" })).response
				.status,
		).toBe(400);
		const peers = (await fetch(`${url}/devices`, {
			headers: { Authorization: `Bearer ${alice.data.token}` },
		}).then((r) => r.json())) as { devices: Array<{ id: string }> };
		expect(peers.devices.map((p) => p.id)).toEqual(["laptop"]);
		const send = (to: string) =>
			fetch(`${url}/send`, {
				method: "POST",
				headers: { Authorization: `Bearer ${alice.data.token}` },
				body: JSON.stringify({
					to,
					sealed: "ciphertext",
					from: c.id,
					publicKey: c.publicKey,
				}),
			});
		expect((await send(c.id)).status).toBe(404);
		expect((await send(b.id)).status).toBe(200);
		const received = (await fetch(`${url}/poll`, {
			headers: { Authorization: `Bearer ${laptop.data.token}` },
		}).then((r) => r.json())) as {
			messages: Array<{ from: string; publicKey: string }>;
		};
		expect(received.messages[0].from).toBe(a.id);
		expect(received.messages[0].publicKey).toBe(a.publicKey);
		for (let i = 0; i < 16; i++) expect((await send(b.id)).status).toBe(200);
		expect((await send(b.id)).status).toBe(429);
		expect(
			(
				await fetch(`${url}/devices`, {
					headers: { Authorization: "Bearer guessed" },
				})
			).status,
		).toBe(401);
	} finally {
		relay.closeAllConnections();
		await new Promise<void>((resolve) => relay.close(() => resolve()));
	}
});

test("peer presence expires and cannot be renewed with an expired session", async () => {
	let now = Date.now();
	const relay = createPeerRelay({
		now: () => now,
		verifyIdentity: async () => ({ owner, expiresAt: now + 60_000 }),
	});
	await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`,
		device = keys("device");
	try {
		const session = (await fetch(`${url}/connect`, {
			method: "POST",
			body: JSON.stringify({
				deviceId: device.id,
				name: device.name,
				publicKey: device.publicKey,
				idToken: "verified",
			}),
		}).then((r) => r.json())) as { token: string };
		now += 46_000;
		expect(
			(
				await fetch(`${url}/devices`, {
					headers: { Authorization: `Bearer ${session.token}` },
				})
			).status,
		).toBe(401);
	} finally {
		relay.closeAllConnections();
		await new Promise<void>((resolve) => relay.close(() => resolve()));
	}
});
