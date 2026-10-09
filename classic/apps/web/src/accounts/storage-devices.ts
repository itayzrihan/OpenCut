/** Local device keys and encrypted, signed discovery records on a mounted vault. */
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import {
	link,
	mkdir,
	readFile,
	readdir,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { accountsRoot, requireAccount } from "./server";
import { seal, unseal } from "./vault-crypto";

type Identity = { id: string; publicKey: string; privateKey: string };
export type StorageDevice = {
	id: string;
	name: string;
	fingerprint: string;
	enabled: boolean;
	lastSeenAt: string;
};
type SignedDevice = StorageDevice & { publicKey: string; signature: string };
const validId = /^[a-f0-9-]{36}$/;

async function identity(existingId?: string): Promise<Identity> {
	const directory = join(accountsRoot(), "device-identities"),
		path = join(directory, `${requireAccount().id}.json`);
	await mkdir(directory, { recursive: true });
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const keys = generateKeyPairSync("ed25519"),
		value = {
			id: existingId ?? randomUUID(),
			publicKey: keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
			privateKey: keys.privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
		};
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), {
		flag: "wx",
		mode: 0o600,
	});
	try {
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(temporary);
	}
	return JSON.parse(await readFile(path, "utf8"));
}

function fingerprint(publicKey: string) {
	const key = createPublicKey(publicKey);
	if (key.asymmetricKeyType !== "ed25519")
		throw new Error("Unsupported device identity");
	return createHash("sha256")
		.update(key.export({ type: "spki", format: "der" }))
		.digest("hex");
}

export async function localStorageDevice({
	existingId,
	name = hostname(),
}: {
	existingId?: string;
	name?: string;
}): Promise<StorageDevice> {
	const keys = await identity(existingId);
	if (existingId && keys.id !== existingId)
		throw new Error("Local storage device identity mismatch");
	return {
		id: keys.id,
		name,
		fingerprint: fingerprint(keys.publicKey),
		enabled: true,
		lastSeenAt: new Date().toISOString(),
	};
}

function payload(device: StorageDevice) {
	return Buffer.from(
		JSON.stringify({
			id: device.id,
			name: device.name,
			fingerprint: device.fingerprint,
			enabled: device.enabled,
			lastSeenAt: device.lastSeenAt,
		}),
	);
}

export async function listStorageDevices({
	root,
	key,
}: {
	root: string;
	key: Buffer;
}): Promise<StorageDevice[]> {
	const directory = join(root, "devices");
	const files = await readdir(directory).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const records = files.filter((file) => file.endsWith(".device"));
	if (records.length > 64)
		throw new Error("At most 64 personal devices are supported");
	const devices: StorageDevice[] = [];
	for (const file of records) {
		const id = file.slice(0, -7),
			path = join(directory, file);
		if (!validId.test(id) || (await stat(path)).size > 16_384)
			throw new Error("Invalid device record");
		const record: SignedDevice = JSON.parse(
			unseal({
				data: await readFile(path),
				key: key,
				aad: `${requireAccount().id}:device:${id}`,
			}).toString("utf8"),
		);
		if (
			record.id !== id ||
			typeof record.name !== "string" ||
			!record.name.trim() ||
			Buffer.byteLength(record.name) > 256 ||
			[...record.name].some(
				(letter) => letter.charCodeAt(0) <= 31 || letter.charCodeAt(0) === 127,
			) ||
			typeof record.enabled !== "boolean" ||
			typeof record.lastSeenAt !== "string" ||
			!Number.isFinite(Date.parse(record.lastSeenAt)) ||
			typeof record.signature !== "string" ||
			record.fingerprint !== fingerprint(record.publicKey) ||
			!verify(
				null,
				payload(record),
				record.publicKey,
				Buffer.from(record.signature, "base64"),
			)
		)
			throw new Error("Device identity verification failed");
		devices.push({
			id: record.id,
			name: record.name,
			fingerprint: record.fingerprint,
			enabled: record.enabled,
			lastSeenAt: record.lastSeenAt,
		});
	}
	if (
		new Set(devices.map((device) => device.fingerprint)).size !== devices.length
	)
		throw new Error("Duplicate device identity");
	return devices.sort((a, b) => a.name.localeCompare(b.name));
}

export async function publishStorageDevice({
	root,
	key,
	device,
}: {
	root: string;
	key: Buffer;
	device: StorageDevice;
}) {
	const keys = await identity(device.id);
	if (
		keys.id !== device.id ||
		fingerprint(keys.publicKey) !== device.fingerprint
	)
		throw new Error("Local storage device identity mismatch");
	const devices = await listStorageDevices({ root: root, key: key }),
		existing = devices.find((entry) => entry.id === device.id);
	if (!existing && devices.length >= 64)
		throw new Error("At most 64 personal devices are supported");
	if (existing && existing.fingerprint !== device.fingerprint)
		throw new Error("This device identifier belongs to a different machine");
	const directory = join(root, "devices"),
		target = join(directory, `${device.id}.device`),
		temporary = `${target}.${randomUUID()}.partial`;
	await mkdir(directory, { recursive: true });
	const record: SignedDevice = {
		...device,
		publicKey: keys.publicKey,
		signature: sign(null, payload(device), keys.privateKey).toString("base64"),
	};
	await writeFile(
		temporary,
		seal({
			data: Buffer.from(JSON.stringify(record)),
			key: key,
			aad: `${requireAccount().id}:device:${device.id}`,
		}),
		{ flag: "wx" },
	);
	await rename(temporary, target);
}
