/** Ciphertext-only transport; device-key discovery trusts the authenticated relay. */
import {
	createCipheriv,
	createDecipheriv,
	createPrivateKey,
	createPublicKey,
	diffieHellman,
	hkdfSync,
	randomBytes,
} from "node:crypto";

function sharedKey({
	privateKey,
	publicKey,
	owner,
	sender,
	recipient,
}: {
	privateKey: string;
	publicKey: string;
	owner: string;
	sender: string;
	recipient: string;
}) {
	const key = createPublicKey(publicKey);
	if (key.asymmetricKeyType !== "x25519")
		throw new Error("Invalid peer encryption key");
	const secret = diffieHellman({
		privateKey: createPrivateKey(privateKey),
		publicKey: key,
	});
	return Buffer.from(
		hkdfSync(
			"sha256",
			secret,
			Buffer.from(owner),
			Buffer.from(`opencut-media-v1:${[sender, recipient].sort().join(":")}`),
			32,
		),
	);
}
export function sealPeerMessage(input: {
	privateKey: string;
	publicKey: string;
	owner: string;
	sender: string;
	recipient: string;
	value: unknown;
}) {
	const nonce = randomBytes(12),
		key = sharedKey(input);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	cipher.setAAD(
		Buffer.from(`${input.owner}:${input.sender}:${input.recipient}`),
	);
	const bytes = Buffer.from(JSON.stringify(input.value));
	if (bytes.length > 370_000)
		throw new Error("Peer message exceeds its chunk bound");
	const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
	return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
}
export function openPeerMessage(input: {
	privateKey: string;
	publicKey: string;
	owner: string;
	sender: string;
	recipient: string;
	sealed: string;
}): unknown {
	if (
		typeof input.sealed !== "string" ||
		input.sealed.length > 500_000 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(input.sealed)
	)
		throw new Error("Invalid peer envelope");
	const data = Buffer.from(input.sealed, "base64");
	if (data.length < 29) throw new Error("Truncated peer envelope");
	const cipher = createDecipheriv(
		"aes-256-gcm",
		sharedKey(input),
		data.subarray(0, 12),
	);
	cipher.setAAD(
		Buffer.from(`${input.owner}:${input.sender}:${input.recipient}`),
	);
	cipher.setAuthTag(data.subarray(12, 28));
	return JSON.parse(
		Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(
			"utf8",
		),
	);
}
