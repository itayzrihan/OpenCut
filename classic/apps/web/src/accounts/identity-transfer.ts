import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import { accountStorageKey } from "./storage-host";
import {
	requireAccount,
	verifyCurrentAccountPassword,
	installRecoveredAccount,
	type LocalAccount,
} from "./server";
const derive = promisify(scrypt),
	format = "opencut-identity-v1";
export async function exportAccountIdentity(password: string) {
	await verifyCurrentAccountPassword(password);
	const salt = randomBytes(32),
		iv = randomBytes(12),
		key = (await derive(password, salt, 32)) as Buffer;
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(format));
	const data = Buffer.from(
		JSON.stringify({
			account: requireAccount(),
			storageKey: (await accountStorageKey()).toString("base64"),
		}),
	);
	const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
	return {
		format,
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		encrypted: encrypted.toString("base64"),
	};
}
export async function importAccountIdentity({
	value,
	password,
}: {
	value: unknown;
	password: string;
}) {
	if (
		!value ||
		typeof value !== "object" ||
		password.length < 12 ||
		password.length > 1024
	)
		throw new Error("Invalid recovery file or password");
	const packageData = value as Record<string, unknown>;
	if (packageData.format !== format)
		throw new Error("Unsupported recovery format");
	const bytes = ({ name, length }: { name: string; length?: number }) => {
		const text = packageData[name];
		if (
			typeof text !== "string" ||
			text.length > 8192 ||
			!/^[a-zA-Z0-9+/]*={0,2}$/.test(text)
		)
			throw new Error("Invalid recovery encoding");
		const buffer = Buffer.from(text, "base64");
		if (length !== undefined && buffer.length !== length)
			throw new Error("Invalid recovery data length");
		return buffer;
	};
	const salt = bytes({ name: "salt", length: 32 }),
		iv = bytes({ name: "iv", length: 12 }),
		tag = bytes({ name: "tag", length: 16 }),
		encrypted = bytes({ name: "encrypted" });
	const key = (await derive(password, salt, 32)) as Buffer,
		decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAAD(Buffer.from(format));
	decipher.setAuthTag(tag);
	let decoded: { account: LocalAccount; storageKey: string };
	try {
		decoded = JSON.parse(
			Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
				"utf8",
			),
		);
	} catch {
		throw new Error("Recovery password is incorrect or the file is damaged");
	}
	return installRecoveredAccount({
		account: decoded.account,
		key: Buffer.from(decoded.storageKey, "base64"),
		password: password,
	});
}
