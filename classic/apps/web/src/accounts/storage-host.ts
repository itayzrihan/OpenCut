/** Mounted-folder adapter. Snapshot policy is validated by the shared Rust core. */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
	appendFile,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { accountsRoot, accountDataRoot, requireAccount } from "./server";
import { hashFile } from "./migration";
import { assertAccountMediaSource } from "./media-source";
import { MAGIC, seal, unseal } from "./vault-crypto";
import {
	localStorageDevice,
	listStorageDevices,
	publishStorageDevice,
} from "./storage-devices";

export type StorageState = {
	id: string;
	displayName: string;
	storage: {
		mode: "localOnly" | "externalDrive" | "personalDevices";
		destinationId: string | null;
		automaticSnapshots?: boolean;
		devices: {
			id: string;
			name: string;
			fingerprint: string;
			enabled: boolean;
		}[];
	};
};
type Profile = {
	account: StorageState;
	folder: string | null;
	deviceId: string;
};
export type SnapshotManifest = {
	version: number;
	accountId: string;
	snapshotId: string;
	deviceId: string;
	createdAt: string;
	files: { path: string; bytes: number; sha256: string }[];
};
export type StoragePolicy = {
	configure(options: {
		stateJson: string;
		authenticatedId: string;
		configurationJson: string;
	}): string;
	validate(options: { manifestJson: string; authenticatedId: string }): void;
};
type Source = {
	name: string;
	path: string;
	bytes: number;
	mtimeMs: number;
	data?: Buffer;
};
function profilePath() {
	return join(
		accountsRoot(),
		"storage-profiles",
		`${requireAccount().id}.json`,
	);
}
async function atomicJson(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(value), {
		flag: "wx",
		mode: 0o600,
	});
	await rename(temporary, path);
}
export async function readStorageProfile(): Promise<Profile> {
	try {
		return JSON.parse(await readFile(profilePath(), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const account = requireAccount();
		return {
			account: {
				id: account.id,
				displayName: account.displayName,
				storage: { mode: "localOnly", destinationId: null, devices: [] },
			},
			folder: null,
			deviceId: (await localStorageDevice()).id,
		};
	}
}
function inside(root: string, target: string) {
	const path = relative(root, target);
	return !path || (!path.startsWith("..") && !isAbsolute(path));
}
export async function configureStorageFolder(
	folder: string | null,
	policy: StoragePolicy,
	automaticSnapshots = false,
	options: { mode?: StorageState["storage"]["mode"]; deviceName?: string } = {},
) {
	const profile = await readStorageProfile();
	const mode = options.mode ?? (folder ? "externalDrive" : "localOnly");
	if (
		!["localOnly", "externalDrive", "personalDevices"].includes(mode) ||
		(mode === "localOnly") !== (folder === null)
	)
		throw new Error(
			"Choose a folder for external or personal-machine storage, or use local only",
		);
	if (folder !== null) {
		if (!isAbsolute(folder))
			throw new Error("Choose an existing absolute folder path");
		folder = await realpath(folder);
		if (!(await stat(folder)).isDirectory())
			throw new Error("Storage destination must be a folder");
		if (inside(await realpath(accountsRoot()), folder))
			throw new Error(
				"Choose a destination outside the account host's private storage",
			);
	}
	const device = await localStorageDevice(
		profile.deviceId,
		options.deviceName ??
			profile.account.storage.devices.find(
				(entry) => entry.id === profile.deviceId,
			)?.name,
	);
	const root = folder
		? join(folder, "OpenCut Vaults", requireAccount().id)
		: null;
	const key = root ? await accountStorageKey() : null;
	const devices = root && key ? await listStorageDevices(root, key) : [];
	const configuration = {
		mode,
		destinationId: folder
			? ((folder === profile.folder
					? profile.account.storage.destinationId
					: null) ?? randomUUID())
			: null,
		devices: [...devices.filter((entry) => entry.id !== device.id), device].map(
			({ id, name, fingerprint, enabled }) => ({
				id,
				name,
				fingerprint,
				enabled,
			}),
		),
		automaticSnapshots: !!folder && automaticSnapshots,
	};
	profile.account = JSON.parse(
		policy.configure({
			stateJson: JSON.stringify(profile.account),
			authenticatedId: requireAccount().id,
			configurationJson: JSON.stringify(configuration),
		}),
	);
	profile.folder = folder;
	if (root && key) await publishStorageDevice(root, key, device);
	await atomicJson(profilePath(), profile);
	return profile;
}
export async function accountStorageKey(): Promise<Buffer> {
	const path = join(
		accountsRoot(),
		"storage-keys",
		`${requireAccount().id}.key`,
	);
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const key = await readFile(path);
	if (key.length !== 32)
		throw new Error(
			"Invalid account storage key; restore your identity backup",
		);
	return key;
}
async function vault() {
	const profile = await readStorageProfile();
	if (!profile.folder || profile.account.storage.mode === "localOnly")
		throw new Error("Connect a storage folder first");
	const folder = await realpath(profile.folder);
	return {
		profile,
		root: join(folder, "OpenCut Vaults", requireAccount().id),
		key: await accountStorageKey(),
	};
}
async function walk(root: string, prefix = ""): Promise<Source[]> {
	const files: Source[] = [];
	for (const item of await readdir(root, { withFileTypes: true }).catch(
		(error) => {
			if (error.code === "ENOENT" && !prefix) return [];
			throw error;
		},
	)) {
		const path = join(root, item.name),
			name = prefix ? `${prefix}/${item.name}` : item.name;
		if (item.isSymbolicLink())
			throw new Error(`Resolve the symbolic link before syncing: ${name}`);
		if (item.isDirectory()) files.push(...(await walk(path, name)));
		else if (item.isFile()) {
			const info = await stat(path);
			files.push({ name, path, bytes: info.size, mtimeMs: info.mtimeMs });
		}
		if (files.length > 100_000)
			throw new Error("Snapshot exceeds 100,000 files");
	}
	return files;
}
async function decodeObject(
	path: string,
	key: Buffer,
	aad: string,
	expected: { bytes: number; sha256: string },
	target?: string,
	signal?: AbortSignal,
) {
	const info = await stat(path);
	if (info.size !== expected.bytes + 32)
		throw new Error("Snapshot object size mismatch");
	const { open } = await import("node:fs/promises");
	const handle = await open(path, "r");
	const header = Buffer.alloc(16),
		tag = Buffer.alloc(16);
	try {
		await handle.read(header, 0, 16, 0);
		await handle.read(tag, 0, 16, info.size - 16);
	} finally {
		await handle.close();
	}
	if (!header.subarray(0, 4).equals(MAGIC))
		throw new Error("Invalid snapshot object");
	const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(4));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(tag);
	const hash = createHash("sha256");
	const verify = new Transform({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
	});
	const input = expected.bytes
		? createReadStream(path, { start: 16, end: info.size - 17 })
		: Readable.from([]);
	const output = target
		? createWriteStream(target, { flags: "wx" })
		: new Transform({
				transform(_chunk, _encoding, callback) {
					callback();
				},
			});
	await pipeline(input, decipher, verify, output, { signal });
	if (hash.digest("hex") !== expected.sha256)
		throw new Error("Snapshot object checksum mismatch");
}
export async function publishAccountSnapshot(
	policy: StoragePolicy,
	progress: (done: number, total: number) => void = () => {},
	signal?: AbortSignal,
) {
	const { profile, root, key } = await vault(),
		accountId = requireAccount().id,
		snapshotId = randomUUID();
	const originals = await walk(accountDataRoot()),
		files = originals.map((entry) => ({ ...entry }));
	const linkedSources: { path: string; bytes: number; mtimeMs: number }[] = [];
	if (!files.length) throw new Error("There is no account data to sync");
	// Materialize linked media in the snapshot while keeping the local document
	// and its exact original metadata unchanged and recoverable.
	for (const entry of files.filter((entry) =>
		/^projects\/[^/]+\/media\/index.json$/.test(entry.name),
	)) {
		const raw = await readFile(entry.path),
			records = JSON.parse(raw.toString("utf8"));
		let changed = false;
		for (const record of records)
			if (record.storageKind === "linked") {
				const exists = await stat(record.sourcePath).catch((error) => {
					if (error.code === "ENOENT") return null;
					throw error;
				});
				if (!exists?.isFile()) continue; // Keep the exact offline reference in the snapshot.
				const source = await assertAccountMediaSource(record.sourcePath),
					info = await stat(source);
				linkedSources.push({
					path: source,
					bytes: info.size,
					mtimeMs: info.mtimeMs,
				});
				const projectPath = entry.name.slice(0, -"media/index.json".length);
				const name = `${projectPath}media/files/${record.id}--${source.split(/[\\/]/).pop()}`;
				files.push({
					name,
					path: source,
					bytes: info.size,
					mtimeMs: info.mtimeMs,
				});
				record.legacySourcePath = record.sourcePath;
				delete record.sourcePath;
				record.storageKind = "copied";
				record.storedPath = name.slice(projectPath.length);
				changed = true;
			}
		if (changed) {
			files.push({
				...entry,
				name: `snapshot-originals/${snapshotId}/${entry.name}`,
				data: raw,
			});
			entry.data = Buffer.from(JSON.stringify(records));
			entry.bytes = entry.data.length;
		}
	}
	const manifest: SnapshotManifest = {
		version: 1,
		accountId,
		snapshotId,
		deviceId: profile.deviceId,
		createdAt: new Date().toISOString(),
		files: [],
	};
	for (const file of files) {
		signal?.throwIfAborted();
		manifest.files.push({
			path: file.name,
			bytes: file.bytes,
			sha256: file.data
				? createHash("sha256").update(file.data).digest("hex")
				: await hashFile(file.path, signal),
		});
	}
	policy.validate({
		manifestJson: JSON.stringify(manifest),
		authenticatedId: accountId,
	});
	await mkdir(join(root, "objects"), { recursive: true });
	await mkdir(join(root, "snapshots"), { recursive: true });
	for (let index = 0; index < files.length; index++) {
		signal?.throwIfAborted();
		const source = files[index],
			entry = manifest.files[index],
			target = join(root, "objects", `${entry.sha256}.blob`),
			aad = `${accountId}:${entry.sha256}`;
		const exists = await stat(target)
			.then(() => true)
			.catch((error) => {
				if (error.code === "ENOENT") return false;
				throw error;
			});
		if (!exists) {
			const temporary = `${target}.${randomUUID()}.partial`,
				iv = randomBytes(12),
				cipher = createCipheriv("aes-256-gcm", key, iv);
			cipher.setAAD(Buffer.from(aad));
			await writeFile(temporary, Buffer.concat([MAGIC, iv]), { flag: "wx" });
			await pipeline(
				source.data
					? Readable.from([source.data])
					: createReadStream(source.path),
				cipher,
				createWriteStream(temporary, { flags: "a" }),
				{ signal },
			);
			await appendFile(temporary, cipher.getAuthTag());
			await decodeObject(temporary, key, aad, entry, undefined, signal);
			await rename(temporary, target);
		} else await decodeObject(target, key, aad, entry, undefined, signal);
		if (!source.data) {
			const after = await stat(source.path);
			if (after.size !== source.bytes || after.mtimeMs !== source.mtimeMs)
				throw new Error(
					"Source changed during sync. No snapshot was published.",
				);
		}
		progress(index + 1, files.length);
	}
	if (
		JSON.stringify(await walk(accountDataRoot())) !== JSON.stringify(originals)
	)
		throw new Error("Account changed during sync. No snapshot was published.");
	signal?.throwIfAborted();
	const encoded = seal(
		Buffer.from(JSON.stringify(manifest)),
		key,
		`${accountId}:manifest:${snapshotId}`,
	);
	const temporary = join(root, "snapshots", `${snapshotId}.partial`);
	await publishStorageDevice(
		root,
		key,
		await localStorageDevice(
			profile.deviceId,
			profile.account.storage.devices.find(
				(entry) => entry.id === profile.deviceId,
			)?.name,
		),
	);
	await writeFile(temporary, encoded, { flag: "wx" });
	await rename(temporary, join(root, "snapshots", `${snapshotId}.manifest`));
	await atomicJson(
		join(accountsRoot(), "snapshot-inventories", `${accountId}.json`),
		{ folder: profile.folder, files: originals, linkedSources },
	);
	return manifest;
}
export async function accountSnapshotNeeded() {
	const profile = await readStorageProfile();
	if (!profile.folder || !profile.account.storage.automaticSnapshots)
		return false;
	const files = await walk(accountDataRoot());
	if (!files.length) return false;
	const linkedSources = [];
	for (const entry of files.filter((entry) =>
		/^projects\/[^/]+\/media\/index.json$/.test(entry.name),
	)) {
		for (const record of JSON.parse(await readFile(entry.path, "utf8")))
			if (record.storageKind === "linked") {
				const exists = await stat(record.sourcePath).catch((error) => {
					if (error.code === "ENOENT") return null;
					throw error;
				});
				if (!exists?.isFile()) continue;
				const path = await assertAccountMediaSource(record.sourcePath),
					info = await stat(path);
				linkedSources.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
			}
	}
	const previous = await readFile(
		join(accountsRoot(), "snapshot-inventories", `${requireAccount().id}.json`),
		"utf8",
	)
		.then((raw) => JSON.parse(raw))
		.catch((error) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
	return (
		!previous ||
		previous.folder !== profile.folder ||
		JSON.stringify(previous.files) !== JSON.stringify(files) ||
		JSON.stringify(previous.linkedSources ?? []) !==
			JSON.stringify(linkedSources)
	);
}
async function readSnapshot(snapshotId: string, policy: StoragePolicy) {
	if (!/^[a-f0-9-]{36}$/.test(snapshotId))
		throw new Error("Invalid snapshot identifier");
	const { root, key } = await vault(),
		accountId = requireAccount().id,
		path = join(root, "snapshots", `${snapshotId}.manifest`);
	if ((await stat(path)).size > 64 * 1024 * 1024)
		throw new Error("Snapshot manifest is too large");
	const manifest: SnapshotManifest = JSON.parse(
		unseal(
			await readFile(path),
			key,
			`${accountId}:manifest:${snapshotId}`,
		).toString("utf8"),
	);
	policy.validate({
		manifestJson: JSON.stringify(manifest),
		authenticatedId: accountId,
	});
	if (manifest.snapshotId !== snapshotId)
		throw new Error("Snapshot identity mismatch");
	return { root, key, manifest };
}
export async function listAccountSnapshots(policy: StoragePolicy) {
	const profile = await readStorageProfile();
	if (!profile.folder) return [];
	const { root } = await vault();
	const files = await readdir(join(root, "snapshots")).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const snapshots = [];
	for (const file of files.filter((file) => file.endsWith(".manifest"))) {
		const { manifest } = await readSnapshot(file.slice(0, -9), policy);
		snapshots.push({
			id: manifest.snapshotId,
			deviceId: manifest.deviceId,
			createdAt: manifest.createdAt,
			files: manifest.files.length,
			bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
		});
	}
	return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function readStorageConnection(policy: StoragePolicy) {
	const profile = await readStorageProfile();
	if (!profile.folder)
		return {
			status: "local" as const,
			devices: [],
			snapshots: [],
			error: null,
		};
	try {
		const { root, key } = await vault();
		const devices = await listStorageDevices(root, key);
		return {
			status: "connected" as const,
			devices,
			snapshots: await listAccountSnapshots(policy),
			error: null,
		};
	} catch (error) {
		return {
			status: "unavailable" as const,
			devices: [],
			snapshots: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
export async function restoreAccountSnapshot(
	snapshotId: string,
	policy: StoragePolicy,
	progress: (done: number, total: number) => void = () => {},
	signal?: AbortSignal,
	preserveExisting = false,
	metadataOnly = false,
) {
	const { root, key, manifest } = await readSnapshot(snapshotId, policy),
		destination = accountDataRoot();
	const originals = await walk(destination);
	if (originals.length && !preserveExisting)
		throw new Error(
			"Restore requires an empty workspace. Existing work is never overwritten.",
		);
	const staging = join(
		accountsRoot(),
		"restores",
		`${requireAccount().id}-${randomUUID()}`,
	);
	await mkdir(staging, { recursive: true });
	const deferredMedia = [];
	for (let index = 0; index < manifest.files.length; index++) {
		const file = manifest.files[index],
			target = resolve(staging, file.path);
		if (metadataOnly && /^projects\/[^/]+\/media\/files\//.test(file.path)) {
			deferredMedia.push(file);
			progress(index + 1, manifest.files.length);
			continue;
		}
		if (!inside(staging, target))
			throw new Error("Snapshot path escapes staging");
		await mkdir(dirname(target), { recursive: true });
		await decodeObject(
			join(root, "objects", `${file.sha256}.blob`),
			key,
			`${manifest.accountId}:${file.sha256}`,
			file,
			target,
			signal,
		);
		progress(index + 1, manifest.files.length);
	}
	if (metadataOnly)
		await atomicJson(join(staging, "offline-restore.json"), {
			snapshotId,
			deferredMedia,
		});
	signal?.throwIfAborted();
	if (JSON.stringify(await walk(destination)) !== JSON.stringify(originals))
		throw new Error(
			"Workspace changed during restore; verified staging was retained",
		);
	// A version switch first publishes the current workspace as another immutable
	// version. Concurrent machines' versions are never merged or discarded.
	const savedCurrent = originals.length
		? await publishAccountSnapshot(policy, progress, signal)
		: null;
	signal?.throwIfAborted();
	if (JSON.stringify(await walk(destination)) !== JSON.stringify(originals))
		throw new Error(
			"Workspace changed before activation; verified staging was retained",
		);
	await mkdir(dirname(destination), { recursive: true });
	const retained = `${destination}.before-restore-${randomUUID()}`;
	const journal = join(
		accountsRoot(),
		"restore-journals",
		`${requireAccount().id}-${randomUUID()}.json`,
	);
	await atomicJson(journal, {
		status: "prepared",
		destination,
		retained,
		staging,
		snapshotId,
		savedCurrent: savedCurrent?.snapshotId,
	});
	let moved = false;
	try {
		await rename(destination, retained);
		moved = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		await rename(staging, destination);
	} catch (error) {
		if (moved) await rename(retained, destination);
		throw error;
	}
	await atomicJson(journal, {
		status: "complete",
		destination,
		retained: moved ? retained : null,
		snapshotId,
		savedCurrent: savedCurrent?.snapshotId,
	});
	return {
		files: manifest.files.length - deferredMedia.length,
		deferredMedia: deferredMedia.length,
		snapshotId,
		savedCurrent: savedCurrent?.snapshotId,
	};
}
