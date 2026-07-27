/* eslint-disable opencut/prefer-object-params -- Adapter internals mirror the Storage API's key/value signatures. */
import type { StorageAdapter } from "@/services/storage/types";
import { localDriveRequest } from "./client";

type ListableStorageAdapter<T> = StorageAdapter<T> & { getAll(): Promise<T[]> };

async function responseError(response: Response): Promise<Error> {
	try {
		const payload = (await response.json()) as { error?: unknown };
		if (typeof payload.error === "string") return new Error(payload.error);
	} catch {
		// Use the status fallback below.
	}
	return new Error(`Local-drive file request failed (${response.status})`);
}

export class LocalDriveJsonAdapter<T> implements StorageAdapter<T> {
	private migrationPromise: Promise<void> | null = null;

	constructor({
		collection,
		legacy,
	}: {
		collection: string;
		legacy?: ListableStorageAdapter<T>;
	}) {
		this.collection = collection;
		this.legacy = legacy;
	}

	private collection: string;
	private legacy?: ListableStorageAdapter<T>;

	private async ensureMigrated() {
		if (!this.legacy) return;
		if (this.migrationPromise) return this.migrationPromise;
		this.migrationPromise = (async () => {
			const marker = `pocut-local-drive-shared-${this.collection}-v1`;
			try {
				if (localStorage.getItem(marker) === "complete") return;
			} catch {
				// Continue without a browser marker.
			}
			const driveValues = await localDriveRequest<T[]>({
				operation: "shared.list",
				payload: { collection: this.collection },
			});
			const ids = new Set(
				driveValues.flatMap((value) => {
					const id = (value as { id?: unknown }).id;
					return typeof id === "string" ? [id] : [];
				}),
			);
			for (const value of await this.legacy!.getAll()) {
				const id = (value as { id?: unknown }).id;
				if (typeof id !== "string" || ids.has(id)) continue;
				await localDriveRequest({
					operation: "shared.put",
					payload: { collection: this.collection, id, value },
				});
			}
			try {
				localStorage.setItem(marker, "complete");
			} catch {
				// A future load will safely merge by id again.
			}
		})();
		return this.migrationPromise;
	}

	async get(key: string): Promise<T | null> {
		await this.ensureMigrated();
		return localDriveRequest({
			operation: "shared.get",
			payload: { collection: this.collection, id: key },
		});
	}

	async set({ key, value }: { key: string; value: T }): Promise<void> {
		await this.ensureMigrated();
		await localDriveRequest({
			operation: "shared.put",
			payload: { collection: this.collection, id: key, value },
		});
	}

	async remove(key: string): Promise<void> {
		await this.ensureMigrated();
		await localDriveRequest({
			operation: "shared.delete",
			payload: { collection: this.collection, id: key },
		});
	}

	async list(): Promise<string[]> {
		return (await this.getAll()).flatMap((value) => {
			const id = (value as { id?: unknown }).id;
			return typeof id === "string" ? [id] : [];
		});
	}

	async getAll(): Promise<T[]> {
		await this.ensureMigrated();
		return localDriveRequest({
			operation: "shared.list",
			payload: { collection: this.collection },
		});
	}

	async clear(): Promise<void> {
		await this.ensureMigrated();
		await localDriveRequest({
			operation: "shared.clear",
			payload: { collection: this.collection },
		});
	}
}

export class LocalDriveFileAdapter implements StorageAdapter<File> {
	private migrationPromise: Promise<void> | null = null;

	constructor({
		kind,
		legacy,
	}: {
		kind: "audio" | "stickers";
		legacy?: StorageAdapter<File>;
	}) {
		this.kind = kind;
		this.legacy = legacy;
	}

	private kind: "audio" | "stickers";
	private legacy?: StorageAdapter<File>;

	private url(id: string, file?: File): string {
		const params = new URLSearchParams({ kind: this.kind, id });
		if (file?.type) params.set("mimeType", file.type);
		return `/api/local-drive/shared-file?${params}`;
	}

	private async putFile(id: string, file: File): Promise<void> {
		const response = await fetch(this.url(id, file), {
			method: "POST",
			body: file,
		});
		if (!response.ok) throw await responseError(response);
	}

	private async ensureMigrated() {
		if (!this.legacy) return;
		if (this.migrationPromise) return this.migrationPromise;
		this.migrationPromise = (async () => {
			const marker = `pocut-local-drive-shared-files-${this.kind}-v1`;
			try {
				if (localStorage.getItem(marker) === "complete") return;
			} catch {
				// Continue without a browser marker.
			}
			const driveIds = new Set(
				await localDriveRequest<string[]>({
					operation: "sharedFile.list",
					payload: { kind: this.kind },
				}),
			);
			for (const id of await this.legacy!.list()) {
				if (driveIds.has(id)) continue;
				const file = await this.legacy!.get(id);
				if (file) await this.putFile(id, file);
			}
			try {
				localStorage.setItem(marker, "complete");
			} catch {
				// A future load will safely merge by id again.
			}
		})();
		return this.migrationPromise;
	}

	async get(key: string): Promise<File | null> {
		await this.ensureMigrated();
		const response = await fetch(this.url(key), { cache: "no-store" });
		if (response.status === 404) return null;
		if (!response.ok) throw await responseError(response);
		const blob = await response.blob();
		return new File([blob], key, {
			type: blob.type,
			lastModified:
				Date.parse(response.headers.get("last-modified") ?? "") || Date.now(),
		});
	}

	async set({ key, value }: { key: string; value: File }): Promise<void> {
		await this.ensureMigrated();
		await this.putFile(key, value);
	}

	async remove(key: string): Promise<void> {
		await this.ensureMigrated();
		await localDriveRequest({
			operation: "sharedFile.delete",
			payload: { kind: this.kind, id: key },
		});
	}

	async list(): Promise<string[]> {
		await this.ensureMigrated();
		return localDriveRequest({
			operation: "sharedFile.list",
			payload: { kind: this.kind },
		});
	}

	async getAll(): Promise<File[]> {
		const files = await Promise.all(
			(await this.list()).map((id) => this.get(id)),
		);
		return files.filter((file): file is File => file !== null);
	}

	async clear(): Promise<void> {
		await this.ensureMigrated();
		await localDriveRequest({
			operation: "sharedFile.clear",
			payload: { kind: this.kind },
		});
	}
}
