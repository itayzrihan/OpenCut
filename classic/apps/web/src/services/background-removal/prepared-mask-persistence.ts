export const PREPARED_MASK_SCHEMA_VERSION = 2;

export type PreparedMaskFrameMetadata = {
	inferenceKey: string;
	width: number;
	height: number;
	contentHash: string;
	byteLength: number;
};

export type PreparedMaskManifest = {
	schemaVersion: typeof PREPARED_MASK_SCHEMA_VERSION;
	groupKey: string;
	lastUsed: number;
	complete: boolean;
	expectedInferenceKeys: string[] | null;
	totalByteSize: number;
	frames: PreparedMaskFrameMetadata[];
};

export type PersistedPreparedMaskFrame = PreparedMaskFrameMetadata & {
	alpha: Uint8Array;
};

export interface PreparedMaskPersistence {
	listGroupKeys(): Promise<string[]>;
	listManifests(): Promise<PreparedMaskManifest[]>;
	getManifest(groupKey: string): Promise<PreparedMaskManifest | null>;
	getFrame({
		groupKey,
		inferenceKey,
	}: {
		groupKey: string;
		inferenceKey: string;
	}): Promise<PersistedPreparedMaskFrame | null>;
	putFrame({
		manifest,
		frame,
	}: {
		manifest: PreparedMaskManifest;
		frame: PersistedPreparedMaskFrame;
	}): Promise<void>;
	putManifest(manifest: PreparedMaskManifest): Promise<void>;
	deleteGroup(groupKey: string): Promise<void>;
}

const DATABASE_NAME = "opencut-background-removal";
const DATABASE_VERSION = 1;
const MANIFEST_STORE = "prepared-mask-manifests";
const FRAME_STORE = "prepared-mask-alpha-chunks";
const FRAME_GROUP_INDEX = "groupKey";

type StoredPreparedMaskFrame = Omit<PersistedPreparedMaskFrame, "alpha"> & {
	id: string;
	groupKey: string;
	alpha: ArrayBuffer;
};

export function createIndexedDbPreparedMaskPersistence(): PreparedMaskPersistence | null {
	if (typeof indexedDB === "undefined") return null;
	return new IndexedDbPreparedMaskPersistence({ factory: indexedDB });
}

export class IndexedDbPreparedMaskPersistence implements PreparedMaskPersistence {
	private database: Promise<IDBDatabase> | null = null;

	constructor(private readonly options: { factory: IDBFactory }) {}

	async listGroupKeys(): Promise<string[]> {
		const database = await this.getDatabase();
		const transaction = database.transaction(
			[MANIFEST_STORE, FRAME_STORE],
			"readonly",
		);
		const complete = waitForTransaction(transaction);
		const manifestKeysPromise = waitForRequest<IDBValidKey[]>(
			transaction.objectStore(MANIFEST_STORE).getAllKeys(),
		);
		const frameGroupKeysPromise = waitForCursorKeys(
			transaction
				.objectStore(FRAME_STORE)
				.index(FRAME_GROUP_INDEX)
				.openKeyCursor(),
		);
		const [manifestKeys, frameGroupKeys] = await Promise.all([
			manifestKeysPromise,
			frameGroupKeysPromise,
		]);
		await complete;
		return [
			...new Set(
				[...manifestKeys, ...frameGroupKeys].filter(
					(key): key is string => typeof key === "string",
				),
			),
		];
	}

	async listManifests(): Promise<PreparedMaskManifest[]> {
		const database = await this.getDatabase();
		const transaction = database.transaction(MANIFEST_STORE, "readonly");
		const complete = waitForTransaction(transaction);
		const manifests = await waitForRequest<PreparedMaskManifest[]>(
			transaction.objectStore(MANIFEST_STORE).getAll(),
		);
		await complete;
		return manifests.filter(isPreparedMaskManifest);
	}

	async getManifest(groupKey: string): Promise<PreparedMaskManifest | null> {
		const database = await this.getDatabase();
		const transaction = database.transaction(MANIFEST_STORE, "readonly");
		const complete = waitForTransaction(transaction);
		const manifest = await waitForRequest<PreparedMaskManifest | undefined>(
			transaction.objectStore(MANIFEST_STORE).get(groupKey),
		);
		await complete;
		return isPreparedMaskManifest(manifest) ? manifest : null;
	}

	async getFrame({
		groupKey,
		inferenceKey,
	}: {
		groupKey: string;
		inferenceKey: string;
	}): Promise<PersistedPreparedMaskFrame | null> {
		const database = await this.getDatabase();
		const transaction = database.transaction(FRAME_STORE, "readonly");
		const complete = waitForTransaction(transaction);
		const stored = await waitForRequest<StoredPreparedMaskFrame | undefined>(
			transaction
				.objectStore(FRAME_STORE)
				.get(buildFrameStorageKey({ groupKey, inferenceKey })),
		);
		await complete;
		if (!stored || stored.groupKey !== groupKey) return null;
		const alpha = new Uint8Array(stored.alpha);
		if (alpha.byteLength !== stored.byteLength) return null;
		return {
			inferenceKey: stored.inferenceKey,
			width: stored.width,
			height: stored.height,
			contentHash: stored.contentHash,
			byteLength: stored.byteLength,
			alpha,
		};
	}

	async putFrame({
		manifest,
		frame,
	}: {
		manifest: PreparedMaskManifest;
		frame: PersistedPreparedMaskFrame;
	}): Promise<void> {
		const database = await this.getDatabase();
		const transaction = database.transaction(
			[MANIFEST_STORE, FRAME_STORE],
			"readwrite",
		);
		const complete = waitForTransaction(transaction);
		const alpha = new Uint8Array(frame.alpha.byteLength);
		alpha.set(frame.alpha);
		transaction.objectStore(FRAME_STORE).put({
			id: buildFrameStorageKey({
				groupKey: manifest.groupKey,
				inferenceKey: frame.inferenceKey,
			}),
			groupKey: manifest.groupKey,
			inferenceKey: frame.inferenceKey,
			width: frame.width,
			height: frame.height,
			contentHash: frame.contentHash,
			byteLength: frame.byteLength,
			alpha: alpha.buffer,
		} satisfies StoredPreparedMaskFrame);
		transaction.objectStore(MANIFEST_STORE).put(manifest);
		await complete;
	}

	async putManifest(manifest: PreparedMaskManifest): Promise<void> {
		const database = await this.getDatabase();
		const transaction = database.transaction(MANIFEST_STORE, "readwrite");
		const complete = waitForTransaction(transaction);
		transaction.objectStore(MANIFEST_STORE).put(manifest);
		await complete;
	}

	async deleteGroup(groupKey: string): Promise<void> {
		const database = await this.getDatabase();
		const transaction = database.transaction(
			[MANIFEST_STORE, FRAME_STORE],
			"readwrite",
		);
		const complete = waitForTransaction(transaction);
		transaction.objectStore(MANIFEST_STORE).delete(groupKey);
		const frameStore = transaction.objectStore(FRAME_STORE);
		const cursorRequest = frameStore
			.index(FRAME_GROUP_INDEX)
			.openKeyCursor(IDBKeyRange.only(groupKey));
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor) return;
			frameStore.delete(cursor.primaryKey);
			cursor.continue();
		};
		await complete;
	}

	private getDatabase(): Promise<IDBDatabase> {
		if (this.database) return this.database;
		this.database = new Promise((resolve, reject) => {
			const request = this.options.factory.open(
				DATABASE_NAME,
				DATABASE_VERSION,
			);
			request.onerror = () =>
				reject(
					request.error ??
						new Error("Unable to open the prepared matte database"),
				);
			request.onblocked = () =>
				reject(new Error("Opening the prepared matte database was blocked"));
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(MANIFEST_STORE)) {
					database.createObjectStore(MANIFEST_STORE, {
						keyPath: "groupKey",
					});
				}
				if (!database.objectStoreNames.contains(FRAME_STORE)) {
					const frameStore = database.createObjectStore(FRAME_STORE, {
						keyPath: "id",
					});
					frameStore.createIndex(FRAME_GROUP_INDEX, "groupKey");
				}
			};
			request.onsuccess = () => {
				const database = request.result;
				database.onversionchange = () => {
					database.close();
					this.database = null;
				};
				resolve(database);
			};
		});
		void this.database.catch(() => {
			this.database = null;
		});
		return this.database;
	}
}

function buildFrameStorageKey({
	groupKey,
	inferenceKey,
}: {
	groupKey: string;
	inferenceKey: string;
}): string {
	return `${groupKey}\u0000${inferenceKey}`;
}

function waitForRequest<TResult>(
	request: IDBRequest<TResult>,
): Promise<TResult> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Prepared matte request failed"));
	});
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(
				transaction.error ?? new Error("Prepared matte transaction failed"),
			);
		transaction.onabort = () =>
			reject(
				transaction.error ??
					new Error("Prepared matte transaction was aborted"),
			);
	});
}

function waitForCursorKeys(
	request: IDBRequest<IDBCursor | null>,
): Promise<IDBValidKey[]> {
	return new Promise((resolve, reject) => {
		const keys: IDBValidKey[] = [];
		request.onsuccess = () => {
			const cursor = request.result;
			if (!cursor) {
				resolve(keys);
				return;
			}
			keys.push(cursor.key);
			cursor.continue();
		};
		request.onerror = () =>
			reject(
				request.error ?? new Error("Reading prepared matte group keys failed"),
			);
	});
}

function isPreparedMaskManifest(
	value: PreparedMaskManifest | undefined,
): value is PreparedMaskManifest {
	return (
		value?.schemaVersion === PREPARED_MASK_SCHEMA_VERSION &&
		typeof value.groupKey === "string" &&
		Number.isFinite(value.lastUsed) &&
		typeof value.complete === "boolean" &&
		(value.expectedInferenceKeys === null ||
			(Array.isArray(value.expectedInferenceKeys) &&
				value.expectedInferenceKeys.length > 0 &&
				value.expectedInferenceKeys.every(
					(key) => typeof key === "string" && key.length > 0,
				))) &&
		Number.isFinite(value.totalByteSize) &&
		Array.isArray(value.frames)
	);
}
