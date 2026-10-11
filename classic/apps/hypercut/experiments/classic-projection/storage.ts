const DB = "hypercut-v1";
let database: Promise<IDBDatabase> | undefined;
function db() {
	return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore("projects", { keyPath: "id" });
			req.result.createObjectStore("media");
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	}));
}
export async function readStore<T>(
	store: string,
	key: IDBValidKey,
): Promise<T | undefined> {
	const d = await db();
	return new Promise((resolve, reject) => {
		const r = d.transaction(store).objectStore(store).get(key);
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}
export async function writeStore(
	store: string,
	value: unknown,
	key?: IDBValidKey,
): Promise<void> {
	const d = await db();
	return new Promise((resolve, reject) => {
		const t = d.transaction(store, "readwrite");
		t.objectStore(store).put(value, key);
		t.oncomplete = () => resolve();
		t.onerror = () => reject(t.error);
		t.onabort = () => reject(t.error ?? Error("Storage transaction aborted"));
	});
}
export async function listProjects(): Promise<
	{ id: string; name: string; updatedAt: number }[]
> {
	const d = await db();
	return new Promise((resolve, reject) => {
		const r = d.transaction("projects").objectStore("projects").openCursor();
		const rows: { id: string; name: string; updatedAt: number }[] = [];
		r.onsuccess = () => {
			const c = r.result;
			if (c) {
				rows.push({
					id: c.value.id,
					name: c.value.name,
					updatedAt: c.value.updatedAt,
				});
				c.continue();
			} else resolve(rows.sort((a, b) => b.updatedAt - a.updatedAt));
		};
		r.onerror = () => reject(r.error);
	});
}
