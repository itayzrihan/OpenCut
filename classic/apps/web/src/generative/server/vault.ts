/** Account-scoped PIN vault. No export route; paid requests always unlock afresh. */
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt,
} from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const AAD = Buffer.from("opencut-director-vault-v1");
const host = globalThis as typeof globalThis & {
	__directorLeases?: Map<string, { key: string; until: number }>;
	__directorFailures?: Map<string, { count: number; until: number }>;
};
const leases = (host.__directorLeases ??= new Map());
const failures = (host.__directorFailures ??= new Map());
export function pinValid(pin: unknown): asserts pin is string {
	if (typeof pin !== "string" || !/^\d{6,16}$/.test(pin))
		throw new Error("Use a PIN of6–16 digits");
}
const derive = ({ pin, salt }: { pin: string; salt: Buffer }) =>
	new Promise<Buffer>((resolve, reject) =>
		scrypt(
			pin,
			salt,
			32,
			{ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
			(e, key) => (e ? reject(e) : resolve(key)),
		),
	);
export async function configured(root: string) {
	return readFile(join(root, "vault.json")).then(
		() => true,
		() => false,
	);
}
export async function setup({
	root,
	pin,
	key,
}: {
	root: string;
	pin: unknown;
	key: unknown;
}) {
	pinValid(pin);
	if (typeof key !== "string" || !key || key.length > 1024 || /\s/.test(key))
		throw new Error("Invalid API key");
	await mkdir(root, { recursive: true, mode: 0o700 });
	const salt = randomBytes(16),
		nonce = randomBytes(12),
		cipher = createCipheriv(
			"aes-256-gcm",
			await derive({ pin: pin, salt: salt }),
			nonce,
		);
	cipher.setAAD(AAD);
	const bytes = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
	await writeFile(
		join(root, "vault.json"),
		JSON.stringify({
			version: 1,
			salt: salt.toString("base64"),
			nonce: nonce.toString("base64"),
			ciphertext: bytes.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		}),
		{ mode: 0o600, flag: "wx" },
	);
}
export async function unlock({ root, pin }: { root: string; pin: unknown }) {
	pinValid(pin);
	const old = failures.get(root);
	if (old && old.until > performance.now())
		throw new Error("Too many PIN attempts. Wait two minutes.");
	try {
		const v = JSON.parse(await readFile(join(root, "vault.json"), "utf8"));
		const decipher = createDecipheriv(
			"aes-256-gcm",
			await derive({ pin: pin, salt: Buffer.from(v.salt, "base64") }),
			Buffer.from(v.nonce, "base64"),
		);
		decipher.setAAD(AAD);
		decipher.setAuthTag(Buffer.from(v.tag, "base64"));
		const key = Buffer.concat([
			decipher.update(Buffer.from(v.ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");
		leases.set(root, { key, until: performance.now() + 900_000 });
		failures.delete(root);
	} catch {
		const count = (old?.count ?? 0) + 1;
		failures.set(root, {
			count: count >= 5 ? 0 : count,
			until: count >= 5 ? performance.now() + 120_000 : 0,
		});
		throw new Error("Incorrect PIN or unavailable vault");
	}
}
export function keyFor(root: string) {
	const lease = leases.get(root);
	if (!lease || lease.until <= performance.now()) {
		leases.delete(root);
		throw new Error(
			"PIN lease expired. Unlock to resume free checks; no new generation will be sent.",
		);
	}
	return lease.key;
}
export function seconds(root: string) {
	const lease = leases.get(root);
	if (!lease || lease.until <= performance.now()) {
		leases.delete(root);
		return 0;
	}
	return Math.floor((lease.until - performance.now()) / 1000);
}
export function lock(root: string) {
	leases.delete(root);
}
