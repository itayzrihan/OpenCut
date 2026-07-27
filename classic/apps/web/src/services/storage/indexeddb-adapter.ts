import type { StorageAdapter } from "./types";

const DELETE_DATABASE_BLOCKED_TIMEOUT_MS = 5_000;

function getOperationError({
	error,
	fallbackMessage,
}: {
	error: DOMException | null | undefined;
	fallbackMessage: string;
}): Error {
	return error ?? new Error(fallbackMessage);
}

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor({
		dbName,
		storeName,
		version = 1,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}

	private async getDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(this.dbName, this.version);

			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => db.close();
				resolve(db);
			};

			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName, { keyPath: "id" });
				}
			};
		});
	}

	private async runRequest<TResult>({
		mode,
		createRequest,
	}: {
		mode: IDBTransactionMode;
		createRequest: (store: IDBObjectStore) => IDBRequest<TResult>;
	}): Promise<TResult> {
		const db = await this.getDB();

		return new Promise((resolve, reject) => {
			let settled = false;
			let request: IDBRequest<TResult> | null = null;
			let requestSucceeded = false;
			let requestResult: TResult;
			let transaction: IDBTransaction | null = null;

			const closeDatabase = () => {
				db.close();
			};

			const resolveOnce = () => {
				if (settled) {
					return;
				}
				settled = true;
				closeDatabase();
				resolve(requestResult);
			};

			const rejectOnce = (error: Error) => {
				if (settled) {
					return;
				}
				settled = true;
				closeDatabase();
				reject(error);
			};

			try {
				transaction = db.transaction([this.storeName], mode);

				transaction.oncomplete = () => {
					if (!requestSucceeded) {
						rejectOnce(
							getOperationError({
								error: request?.error,
								fallbackMessage: `IndexedDB request for ${this.dbName}/${this.storeName} completed without a result`,
							}),
						);
						return;
					}

					resolveOnce();
				};
				transaction.onerror = () => {
					rejectOnce(
						getOperationError({
							error: transaction?.error ?? request?.error,
							fallbackMessage: `IndexedDB transaction failed for ${this.dbName}/${this.storeName}`,
						}),
					);
				};
				transaction.onabort = () => {
					rejectOnce(
						getOperationError({
							error: transaction?.error ?? request?.error,
							fallbackMessage: `IndexedDB transaction was aborted for ${this.dbName}/${this.storeName}`,
						}),
					);
				};

				const store = transaction.objectStore(this.storeName);
				request = createRequest(store);
				const activeRequest = request;
				activeRequest.onsuccess = () => {
					requestResult = activeRequest.result;
					requestSucceeded = true;
				};
				activeRequest.onerror = () => {
					rejectOnce(
						getOperationError({
							error: activeRequest.error,
							fallbackMessage: `IndexedDB request failed for ${this.dbName}/${this.storeName}`,
						}),
					);
				};
			} catch (error) {
				try {
					transaction?.abort();
				} catch {
					// The transaction may already be inactive or aborted.
				}
				rejectOnce(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async get(key: string): Promise<T | null> {
		const result = await this.runRequest<T | undefined>({
			mode: "readonly",
			createRequest: (store) => store.get(key),
		});
		return result ?? null;
	}

	async set({ key, value }: { key: string; value: T }): Promise<void> {
		await this.runRequest({
			mode: "readwrite",
			createRequest: (store) => store.put({ id: key, ...value }),
		});
	}

	async remove(key: string): Promise<void> {
		await this.runRequest({
			mode: "readwrite",
			createRequest: (store) => store.delete(key),
		});
	}

	async list(): Promise<string[]> {
		const keys = await this.runRequest<IDBValidKey[]>({
			mode: "readonly",
			createRequest: (store) => store.getAllKeys(),
		});
		return keys.filter((key): key is string => typeof key === "string");
	}

	async getAll(): Promise<T[]> {
		return this.runRequest<T[]>({
			mode: "readonly",
			createRequest: (store) => store.getAll(),
		});
	}

	async clear(): Promise<void> {
		await this.runRequest({
			mode: "readwrite",
			createRequest: (store) => store.clear(),
		});
	}
}

export async function deleteDatabase({
	dbName,
	blockedTimeoutMs = DELETE_DATABASE_BLOCKED_TIMEOUT_MS,
}: {
	dbName: string;
	blockedTimeoutMs?: number;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(dbName);
		const blockedWaitMs = Number.isFinite(blockedTimeoutMs)
			? Math.max(0, blockedTimeoutMs)
			: DELETE_DATABASE_BLOCKED_TIMEOUT_MS;
		let blockedTimer: ReturnType<typeof setTimeout> | null = null;
		let settled = false;

		const clearBlockedTimer = () => {
			if (blockedTimer !== null) {
				clearTimeout(blockedTimer);
				blockedTimer = null;
			}
		};

		const resolveOnce = () => {
			if (settled) {
				return;
			}
			settled = true;
			clearBlockedTimer();
			resolve();
		};

		const rejectOnce = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearBlockedTimer();
			reject(error);
		};

		request.onsuccess = resolveOnce;
		request.onerror = () => {
			rejectOnce(
				getOperationError({
					error: request.error,
					fallbackMessage: `Failed to delete IndexedDB database "${dbName}"`,
				}),
			);
		};
		request.onblocked = () => {
			if (blockedTimer !== null || settled) {
				return;
			}

			blockedTimer = setTimeout(() => {
				rejectOnce(
					new Error(
						`Deleting IndexedDB database "${dbName}" remained blocked for ${blockedWaitMs}ms. Close other tabs using this app and try again.`,
					),
				);
			}, blockedWaitMs);
		};
	});
}
