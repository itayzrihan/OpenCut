import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const MAGIC = Buffer.from("OCV1");

export function seal({
	data,
	key,
	aad,
}: {
	data: Buffer;
	key: Buffer;
	aad: string;
}) {
	const iv = randomBytes(12),
		cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad));
	return Buffer.concat([
		MAGIC,
		iv,
		cipher.update(data),
		cipher.final(),
		cipher.getAuthTag(),
	]);
}

export function unseal({
	data,
	key,
	aad,
}: {
	data: Buffer;
	key: Buffer;
	aad: string;
}) {
	if (data.length < 32 || !data.subarray(0, 4).equals(MAGIC))
		throw new Error("Invalid encrypted snapshot");
	const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(4, 16));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(data.subarray(-16));
	return Buffer.concat([
		decipher.update(data.subarray(16, -16)),
		decipher.final(),
	]);
}
