import { encodeBrowserGraph } from "./browser-archive-codec";
const CHUNK = 8 * 1024 * 1024;
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
export async function archiveLegacyBrowserData(
	onProgress: (message: string) => void,
) {
	const run = crypto.randomUUID();
	async function storeBlob(blob: Blob) {
		const id = crypto.randomUUID();
		const response = await fetch(
			`/api/accounts/browser-archive?run=${run}&id=${id}`,
			{ method: "PUT", body: blob },
		);
		const result = await response.json();
		if (!response.ok) throw new Error(result.error);
		if (result.bytes !== blob.size)
			throw new Error("Browser archive size verification failed");
		for (
			let offset = 0, index = 0;
			offset < blob.size;
			offset += CHUNK, index++
		) {
			const hash = Array.from(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						await blob.slice(offset, offset + CHUNK).arrayBuffer(),
					),
				),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			if (result.chunks[index] !== hash)
				throw new Error("Browser archive byte verification failed");
		}
		return id;
	}
	const databases = [],
		files: {
			path: string[];
			object: string;
			bytes: number;
			mimeType: string;
			lastModified: number;
		}[] = [];
	for (const entry of await indexedDB.databases()) {
		if (!entry.name?.startsWith("video-editor-")) continue;
		onProgress(`Archiving original ${entry.name}…`);
		const db = await requestValue(indexedDB.open(entry.name));
		try {
			const names = [...db.objectStoreNames];
			if (!names.length) {
				databases.push({ name: entry.name, version: db.version, stores: [] });
				continue;
			}
			const transaction = db.transaction(names, "readonly");
			const reading = names.map((name) => {
				const store = transaction.objectStore(name);
				const schema = {
					name,
					keyPath: store.keyPath,
					autoIncrement: store.autoIncrement,
					indexes: [...store.indexNames].map((id) => {
						const index = store.index(id);
						return {
							name: id,
							keyPath: index.keyPath,
							unique: index.unique,
							multiEntry: index.multiEntry,
						};
					}),
				};
				return Promise.all([
					requestValue(store.getAllKeys()),
					requestValue(store.getAll()),
				]).then(([keys, values]) => ({ ...schema, keys, values }));
			});
			const stores = [];
			for (const item of await Promise.all(reading)) {
				const { keys, values, ...schema } = item;
				const graph = await encodeBrowserGraph({ keys, values }, storeBlob);
				stores.push({
					...schema,
					graph: await storeBlob(
						new Blob([JSON.stringify(graph)], { type: "application/json" }),
					),
				});
			}
			databases.push({ name: entry.name, version: db.version, stores });
		} finally {
			db.close();
		}
	}
	async function archiveDirectory(
		directory: FileSystemDirectoryHandle,
		prefix: string[],
	) {
		for await (const [name, handle] of directory.entries()) {
			const path = [...prefix, name];
			if (handle.kind === "directory")
				await archiveDirectory(handle as FileSystemDirectoryHandle, path);
			else {
				const file = await (handle as FileSystemFileHandle).getFile();
				onProgress(`Archiving browser media ${files.length + 1}…`);
				files.push({
					path,
					object: await storeBlob(file),
					bytes: file.size,
					mimeType: file.type,
					lastModified: file.lastModified,
				});
			}
		}
	}
	for await (const [name, handle] of (
		await navigator.storage.getDirectory()
	).entries()) {
		if (
			handle.kind === "directory" &&
			/^(media-files-|font-files-|shared-library-)/.test(name)
		)
			await archiveDirectory(handle as FileSystemDirectoryHandle, [name]);
	}
	const manifest = {
		format: "opencut-browser-archive-v1",
		createdAt: new Date().toISOString(),
		databases,
		files,
		preferences: window.__opencutLegacyPreferences(),
	};
	const response = await fetch(`/api/accounts/browser-archive?run=${run}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(manifest),
	});
	if (!response.ok) throw new Error((await response.json()).error);
	return run;
}
