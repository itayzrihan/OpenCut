import { expect, mock, test } from "bun:test";
import type { BrowserFileHandle } from "@/media/browser-file-handle";
import { captureFileDrop } from "@/media/browser-file-drop";

const databases = new Map<string, Map<string, unknown>>();
let rejectWrite: string | undefined;
mock.module("./indexeddb-adapter", () => ({
	IndexedDBAdapter: class {
		private store: Map<string, unknown>;
		constructor({ dbName, accountId }: { dbName: string; accountId: string }) {
			const namespace = `${accountId}:${dbName}`;
			this.store = databases.get(namespace) ?? new Map();
			databases.set(namespace, this.store);
		}
		async get(key: string) {
			return this.store.get(key);
		}
		async set({ key, value }: { key: string; value: unknown }) {
			if (rejectWrite) {
				const error = new DOMException(
					"Simulated storage failure",
					rejectWrite,
				);
				rejectWrite = undefined;
				throw error;
			}
			this.store.set(key, value);
		}
	},
}));
const { hostedMedia } = await import("./hosted-media");

test("a dropped original is preferred, with a durable browser copy after permission expires", async () => {
	const file = new File(["video"], "camera.mov", {
		type: "video/quicktime",
		lastModified: 42,
	});
	const original = new File([file], file.name, {
		type: file.type,
		lastModified: file.lastModified,
	});
	let canRead = true;
	const handle = {
		kind: "file",
		name: file.name,
		getFile: async () => {
			if (!canRead)
				throw new DOMException("Permission required", "NotAllowedError");
			return original;
		},
		requestPermission: async () => {
			canRead = true;
			return "granted";
		},
	} as BrowserFileHandle;
	let calledDuringDrop = false;
	const drop = captureFileDrop({
		files: [file],
		items: [
			{
				kind: "file",
				getAsFileSystemHandle: async () => {
					calledDuringDrop = true;
					return handle;
				},
			},
		],
	} as unknown as DataTransfer);
	expect(calledDuringDrop).toBe(true);
	expect(drop.files[0]).toBe(file);
	const store = hostedMedia("project", "owner");
	const saved = await store.save({
		asset: {
			id: "clip",
			name: file.name,
			file,
			type: "video",
			duration: 3,
			thumbnailUrl: "data:image/jpeg;base64,AA==",
		},
		fileHandle: await drop.handles.get(file),
	});
	expect(saved.storageKind).toBe("linked");
	expect(saved.hasLocalCopy).toBe(true);
	const record = await hostedMedia("project", "owner").records.get("clip");
	expect(record?.file).toBe(file);
	expect(record?.fileHandle).toBe(handle);
	expect(
		await hostedMedia("project", "other").records.get("clip"),
	).toBeUndefined();
	if (!record) throw new Error("Linked record was not saved");
	expect((await store.hydrate({ record })).file).toBe(original);
	canRead = false;
	const reopened = await hostedMedia("project", "owner").hydrate({ record });
	expect(reopened.file).toBe(file);
	expect(reopened.duration).toBe(3);
	expect(reopened.thumbnailUrl).toBe("data:image/jpeg;base64,AA==");
	expect(reopened.missing).toBe(false);
});

test("unclonable handles keep the local copy and quota exhaustion keeps the handle", async () => {
	const file = new File(["media"], "test.mp4", { type: "video/mp4" });
	let canRead = false;
	const fileHandle = {
		kind: "file",
		name: file.name,
		getFile: async () => {
			if (!canRead)
				throw new DOMException("Permission required", "NotAllowedError");
			return file;
		},
		requestPermission: async () => {
			canRead = true;
			return "granted";
		},
	} as BrowserFileHandle;
	const asset = { id: "asset", name: file.name, file, type: "video" as const };
	const store = hostedMedia("storage-errors", "owner");
	rejectWrite = "DataCloneError";
	const copied = await store.save({ asset, fileHandle });
	expect(copied.storageKind).toBe("copied");
	expect(copied.hasLocalCopy).toBe(true);

	rejectWrite = "QuotaExceededError";
	const linked = await store.save({ asset, fileHandle });
	expect(linked.storageKind).toBe("linked");
	expect(linked.hasLocalCopy).toBe(false);
	const record = await store.records.get(asset.id);
	if (!record) throw new Error("Fallback handle was not stored");
	expect((await store.hydrate({ record })).missing).toBe(true);
	expect((await store.hydrate({ record, requestAccess: true })).file).toBe(
		file,
	);
});

test("a browser without dropped handles keeps a local copy and can reopen it", async () => {
	const file = new File(["audio"], "voice.wav", { type: "audio/wav" });
	const drop = captureFileDrop({
		files: [file],
		items: [{ kind: "file" }],
	} as unknown as DataTransfer);
	expect(drop.handles.size).toBe(0);
	const store = hostedMedia("fallback", "owner");
	await store.save({
		asset: { id: "clip", name: file.name, file, type: "audio" },
	});
	const record = await store.records.get("clip");
	if (!record) throw new Error("Copied record was not saved");
	expect(record.storageKind).toBe("copied");
	expect((await store.hydrate({ record })).file).toBe(file);
});
