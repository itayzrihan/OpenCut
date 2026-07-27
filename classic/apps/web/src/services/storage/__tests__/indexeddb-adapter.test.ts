/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test doubles intentionally implement only the IndexedDB surface used here. */
import { afterEach, describe, expect, test } from "bun:test";
import { IndexedDBAdapter, deleteDatabase } from "../indexeddb-adapter";

type EventHandler = ((event: Event) => void) | null;

class FakeRequest<TResult> {
	result!: TResult;
	error: DOMException | null = null;
	onsuccess: EventHandler = null;
	onerror: EventHandler = null;
	onblocked: EventHandler = null;
	onupgradeneeded: EventHandler = null;

	succeed(result: TResult): void {
		this.result = result;
		this.onsuccess?.(new Event("success"));
	}

	fail(error: DOMException): void {
		this.error = error;
		this.onerror?.(new Event("error"));
	}

	block(): void {
		this.onblocked?.(new Event("blocked"));
	}
}

class FakeTransaction {
	error: DOMException | null = null;
	oncomplete: EventHandler = null;
	onerror: EventHandler = null;
	onabort: EventHandler = null;
	abortCalls = 0;

	constructor(private readonly store: IDBObjectStore) {}

	objectStore(): IDBObjectStore {
		return this.store;
	}

	abort(): void {
		this.abortCalls++;
	}

	complete(): void {
		this.oncomplete?.(new Event("complete"));
	}

	fail(error: DOMException): void {
		this.error = error;
		this.onerror?.(new Event("error"));
	}

	abortWith(error: DOMException): void {
		this.error = error;
		this.onabort?.(new Event("abort"));
	}
}

function createOperationHarness() {
	const operationRequest = new FakeRequest<unknown>();
	const store = {
		get: () => operationRequest,
		put: () => operationRequest,
		delete: () => operationRequest,
		getAllKeys: () => operationRequest,
		getAll: () => operationRequest,
		clear: () => operationRequest,
	} as unknown as IDBObjectStore;
	const transaction = new FakeTransaction(store);
	let closeCalls = 0;
	const database = {
		onversionchange: null,
		objectStoreNames: {
			contains: () => true,
		},
		transaction: () => transaction,
		createObjectStore: () => store,
		close: () => {
			closeCalls++;
		},
	} as unknown as IDBDatabase;
	const openRequest = new FakeRequest<IDBDatabase>();
	const factory = {
		open: () => {
			queueMicrotask(() => openRequest.succeed(database));
			return openRequest as unknown as IDBOpenDBRequest;
		},
	} as unknown as IDBFactory;

	return {
		factory,
		operationRequest,
		transaction,
		getCloseCalls: () => closeCalls,
	};
}

const originalIndexedDB = globalThis.indexedDB;

function installIndexedDB(factory: IDBFactory): void {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		writable: true,
		value: factory,
	});
}

async function flushTasks(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	if (originalIndexedDB === undefined) {
		Reflect.deleteProperty(globalThis, "indexedDB");
		return;
	}

	installIndexedDB(originalIndexedDB);
});

describe("IndexedDBAdapter", () => {
	test("waits for a write transaction to commit before resolving", async () => {
		const harness = createOperationHarness();
		installIndexedDB(harness.factory);
		const adapter = new IndexedDBAdapter<{ name: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		let state = "pending";

		const write = adapter
			.set({ key: "project-1", value: { name: "Project" } })
			.then(() => {
				state = "resolved";
			});
		await flushTasks();
		harness.operationRequest.succeed("project-1");
		await Promise.resolve();

		expect(state).toBe("pending");
		expect(harness.getCloseCalls()).toBe(0);

		harness.transaction.complete();
		await write;

		expect(state).toBe("resolved");
		expect(harness.getCloseCalls()).toBe(1);
	});

	test("rejects once on request errors and closes the database", async () => {
		const harness = createOperationHarness();
		installIndexedDB(harness.factory);
		const adapter = new IndexedDBAdapter<{ name: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		const requestError = new DOMException("Storage full", "QuotaExceededError");
		const transactionError = new DOMException("Aborted", "AbortError");

		const write = adapter.set({
			key: "project-1",
			value: { name: "Project" },
		});
		await flushTasks();
		harness.operationRequest.fail(requestError);

		await expect(write).rejects.toBe(requestError);
		harness.transaction.fail(transactionError);
		harness.transaction.abortWith(transactionError);

		expect(harness.getCloseCalls()).toBe(1);
	});

	test("rejects aborted transactions even if the request did not fail", async () => {
		const harness = createOperationHarness();
		installIndexedDB(harness.factory);
		const adapter = new IndexedDBAdapter<{ name: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		const abortError = new DOMException("Transaction aborted", "AbortError");

		const removal = adapter.remove("project-1");
		await flushTasks();
		harness.transaction.abortWith(abortError);

		await expect(removal).rejects.toBe(abortError);
		expect(harness.getCloseCalls()).toBe(1);
	});

	test("rejects transaction errors after a successful request", async () => {
		const harness = createOperationHarness();
		installIndexedDB(harness.factory);
		const adapter = new IndexedDBAdapter<{ name: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		const transactionError = new DOMException("Commit failed", "UnknownError");

		const clearing = adapter.clear();
		await flushTasks();
		harness.operationRequest.succeed(undefined);
		harness.transaction.fail(transactionError);

		await expect(clearing).rejects.toBe(transactionError);
		expect(harness.getCloseCalls()).toBe(1);
	});

	test("closes read handles after the read transaction completes", async () => {
		const harness = createOperationHarness();
		installIndexedDB(harness.factory);
		const adapter = new IndexedDBAdapter<{ name: string }>({
			dbName: "projects",
			storeName: "projects",
		});
		let state = "pending";

		const read = adapter.get("project-1").then((value) => {
			state = "resolved";
			return value;
		});
		await flushTasks();
		harness.operationRequest.succeed({ name: "Project" });
		await Promise.resolve();

		expect(state).toBe("pending");
		expect(harness.getCloseCalls()).toBe(0);

		harness.transaction.complete();

		expect(await read).toEqual({ name: "Project" });
		expect(harness.getCloseCalls()).toBe(1);
	});
});

describe("deleteDatabase", () => {
	test("rejects with recovery guidance when deletion stays blocked", async () => {
		const deleteRequest = new FakeRequest<undefined>();
		installIndexedDB({
			deleteDatabase: () => deleteRequest as unknown as IDBOpenDBRequest,
		} as unknown as IDBFactory);

		const deletion = deleteDatabase({
			dbName: "legacy-projects",
			blockedTimeoutMs: 1,
		});
		deleteRequest.block();

		await expect(deletion).rejects.toThrow(
			"Close other tabs using this app and try again",
		);
	});
});
