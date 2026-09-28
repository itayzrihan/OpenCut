import { accountNamespace } from "./browser";
import { sameBrowserRecord } from "./browser-records";
import { saveAllAccountPreferences } from "@/services/local-drive/preferences";
import { localDriveRequest } from "@/services/local-drive/client";

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function committed(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error("Browser import aborted")); });
}
async function copyDatabase(name: string) {
	const source = await requestValue(indexedDB.open(name));
	let destination: IDBDatabase | undefined;
	try {
		const schema = [...source.objectStoreNames].map((storeName) => {
			const store = source.transaction(storeName).objectStore(storeName);
			return { name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map((id) => { const index = store.index(id); return { name: id, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }) };
		});
		const opening = indexedDB.open(accountNamespace(name), source.version);
		opening.onupgradeneeded = () => {
			for (const item of schema) {
				if (opening.result.objectStoreNames.contains(item.name)) continue;
				const store = opening.result.createObjectStore(item.name, { keyPath: item.keyPath, autoIncrement: item.autoIncrement });
				for (const index of item.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
			}
		};
		destination = await requestValue(opening);
		const batches: { name: string; keyPath: string | string[] | null; keys: IDBValidKey[]; values: unknown[] }[] = [];
		for (const item of schema) {
			const originalStore = source.transaction(item.name).objectStore(item.name);
			const [keys, values] = await Promise.all([requestValue(originalStore.getAllKeys()), requestValue(originalStore.getAll())]);
			batches.push({ name: item.name, keyPath: item.keyPath, keys, values });
		}
		if (!batches.length) return;
		// One transaction across every store: an interruption cannot leave half a DB.
		const write = destination.transaction(batches.map((item) => item.name), "readwrite"), done = committed(write);
		for (const item of batches) {
			const target = write.objectStore(item.name);
			for (let i = 0; i < item.keys.length; i++) {
				const existing = target.get(item.keys[i]);
				existing.onsuccess = () => {
					if (existing.result !== undefined) {
						// Existing records are never replaced. Verify structured-clone
						// values (including Blob bytes) after the transaction completes.
						return;
					}
					if (item.keyPath === null) target.add(item.values[i], item.keys[i]); else target.add(item.values[i]);
				};
			}
		}
		await done;
		for (const item of batches) {
			const target = destination.transaction(item.name).objectStore(item.name);
			const copied = await Promise.all(item.keys.map((key) => requestValue(target.get(key))));
			for (let index = 0; index < copied.length; index++) if (!await sameBrowserRecord(copied[index], item.values[index])) throw new Error(`A different browser record already exists: ${name}/${item.name}. Both originals are preserved; resolve the conflict before completing import.`);
		}
	} finally { source.close(); destination?.close(); }
}
async function copyDirectory(source: FileSystemDirectoryHandle, destination: FileSystemDirectoryHandle, onFile: () => void) {
	for await (const [name, handle] of source.entries()) {
		if (handle.kind === "directory") { await copyDirectory(handle as FileSystemDirectoryHandle, await destination.getDirectoryHandle(name, { create: true }), onFile); continue; }
		const original = await (handle as FileSystemFileHandle).getFile();
		let present = true;
		const target = await destination.getFileHandle(name).catch(async (error) => {
			if (error.name !== "NotFoundError") throw error;
			present = false;
			return destination.getFileHandle(name, { create: true });
		});
		const existing = await target.getFile();
		if (present && existing.size !== original.size) throw new Error(`A different account file already exists: ${name}`);
		if (!present) {
			const writer = await target.createWritable();
			try { await writer.write(original); await writer.close(); } catch (error) { await writer.abort().catch(() => {}); throw error; }
		}
		const copy = await target.getFile();
		if (copy.size !== original.size) throw new Error(`File size verification failed: ${name}`);
		for (let offset = 0; offset < original.size; offset += 8 * 1024 * 1024) {
			const end = offset + 8 * 1024 * 1024;
			const a = new Uint8Array(await crypto.subtle.digest("SHA-256", await original.slice(offset, end).arrayBuffer()));
			const b = new Uint8Array(await crypto.subtle.digest("SHA-256", await copy.slice(offset, end).arrayBuffer()));
			if (a.some((byte, index) => byte !== b[index])) throw new Error(`File hash verification failed: ${name}`);
		}
		onFile();
	}
}
export async function importLegacyBrowserData(onProgress: (message: string) => void) {
	const authorization = await fetch("/api/accounts/migration", { cache: "no-store" }).then((r) => r.json());
	if (!authorization.allowed) throw new Error("This account does not own the legacy browser import");
	// Snapshot raw settings in this account before applying them. Never erase originals.
	const preferences = window.__opencutLegacyPreferences();
	const before: Record<string, string> = {};
	for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key && !key.startsWith("legacy-")) before[key] = localStorage.getItem(key)!; }
	localStorage.setItem(`legacy-account-preferences-before-${Date.now()}`, JSON.stringify(before));
	localStorage.setItem(`legacy-preferences-snapshot-${Date.now()}`, JSON.stringify(preferences));
	await localDriveRequest({ operation: "preferences.put", payload: { key: `legacy-preferences-archive-${Date.now()}`, value: JSON.stringify({ before, source: preferences }) } });
	for (const database of await indexedDB.databases()) {
		if (!database.name?.startsWith("video-editor-")) continue;
		const marker = `legacy-browser-db-imported:${database.name}`;
		// Recheck source records on every explicit import; the old app may have
		// saved more work since a previous copy completed.
		onProgress(`Copying ${database.name}…`);
		await copyDatabase(database.name);
		localStorage.setItem(marker, "verified");
	}
	const root = await navigator.storage.getDirectory();
	let files = 0;
	for await (const [name, handle] of root.entries()) {
		if (handle.kind !== "directory" || !/^(media-files-|font-files-|shared-library-)/.test(name)) continue;
		await copyDirectory(handle as FileSystemDirectoryHandle, await root.getDirectoryHandle(accountNamespace(name), { create: true }), () => { onProgress(`Verified ${++files} browser media files`); });
	}
	for (const [key, value] of Object.entries(preferences)) {
		if (key.startsWith("pocut-local-drive-") || key.startsWith("legacy-")) continue;
		localStorage.setItem(key, value);
	}
	// Replay the existing additive browser-to-drive merge against the account copy.
	const markers: string[] = [];
	for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (key?.startsWith("pocut-local-drive-")) markers.push(key); }
	for (const marker of markers) localStorage.removeItem(marker);
	localStorage.setItem("legacy-browser-import-complete", "verified");
	await saveAllAccountPreferences();
	onProgress("Browser data copied and file hashes verified. Reload to open it.");
}
