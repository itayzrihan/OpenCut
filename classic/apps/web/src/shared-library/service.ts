import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { OPFSAdapter } from "@/services/storage/opfs-adapter";
import {
	LocalDriveFileAdapter,
	LocalDriveJsonAdapter,
} from "@/services/local-drive/adapters";
import { StorageQuotaExceededError } from "@/services/storage/quota";
import { storageService } from "@/services/storage/service";
import { normalizeCaptionLayoutSettings } from "@/subtitles/caption-layout";
import { generateUUID } from "@/utils/id";
import type {
	GeneratedBackgroundPreset,
	GeneratedEffectPreset,
	SharedAssetCategory,
	SharedAudioAsset,
	SharedAudioFolder,
	SharedCaptionPreset,
	SharedCategoryScope,
	SharedLibraryManifest,
	SharedStickerAsset,
} from "./types";

const SHARED_DB_VERSION = 1;
const AUDIO_FILES_DIR = "shared-library-audio-files";
const STICKER_FILES_DIR = "shared-library-sticker-files";
const SHARED_LIBRARY_API = "/api/shared-library";

function emptyManifest(): SharedLibraryManifest {
	return {
		version: 1,
		audioAssets: [],
		stickerAssets: [],
		categories: [],
		generatedBackgrounds: [],
		generatedEffects: [],
		captionPresets: [],
		updatedAt: nowIso(),
	};
}

function nowIso(): string {
	return new Date().toISOString();
}

function safeMimeType({ file, fallback }: { file: File; fallback: string }) {
	return file.type || fallback;
}

function filenameWithoutExtension({ name }: { name: string }): string {
	const trimmed = name.trim();
	const dotIndex = trimmed.lastIndexOf(".");
	return dotIndex > 0 ? trimmed.slice(0, dotIndex) : trimmed;
}

function mergeById<T extends { id: string }>({
	repositoryItems,
	localItems,
}: {
	repositoryItems: T[];
	localItems: T[];
}): T[] {
	const repositoryIds = new Set(repositoryItems.map((item) => item.id));
	return [
		...repositoryItems,
		...localItems.filter((item) => !repositoryIds.has(item.id)),
	];
}

async function readFileAsDataUrl({ file }: { file: File }): Promise<string> {
	if (typeof FileReader === "undefined") {
		const buffer = await file.arrayBuffer();
		let binary = "";
		const bytes = new Uint8Array(buffer);
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		return `data:${file.type || "application/octet-stream"};base64,${btoa(
			binary,
		)}`;
	}

	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () => resolve(String(reader.result ?? ""));
		reader.readAsDataURL(file);
	});
}

async function readAudioDuration({
	file,
}: {
	file: File;
}): Promise<number | null> {
	if (typeof Audio === "undefined" || typeof URL === "undefined") {
		return null;
	}

	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const audio = new Audio();
		const cleanup = () => URL.revokeObjectURL(url);
		audio.preload = "metadata";
		audio.onloadedmetadata = () => {
			const duration = Number.isFinite(audio.duration) ? audio.duration : null;
			cleanup();
			resolve(duration);
		};
		audio.onerror = () => {
			cleanup();
			resolve(null);
		};
		audio.src = url;
	});
}

async function readImageSize({
	dataUrl,
}: {
	dataUrl: string;
}): Promise<{ width: number; height: number } | null> {
	if (typeof Image === "undefined") {
		return null;
	}

	return new Promise((resolve) => {
		const image = new Image();
		image.onload = () =>
			resolve({
				width: image.naturalWidth,
				height: image.naturalHeight,
			});
		image.onerror = () => resolve(null);
		image.src = dataUrl;
	});
}

async function checkQuota({ file }: { file: File }): Promise<void> {
	const result = await storageService.canStoreFile({ size: file.size });
	if (!result.canStore) {
		throw new StorageQuotaExceededError({ requiredBytes: file.size });
	}
}

async function cloneStoredFile({
	file,
	name,
	type,
	lastModified,
}: {
	file: File;
	name: string;
	type: string;
	lastModified?: number;
}): Promise<File> {
	if (file.name === name && (!type || file.type === type)) {
		return file;
	}
	const buffer = await file.arrayBuffer();
	return new File([buffer], name, {
		type,
		lastModified: lastModified ?? Date.now(),
	});
}

async function fetchFileFromUrl({
	url,
	name,
	type,
	lastModified,
}: {
	url: string;
	name: string;
	type: string;
	lastModified?: number;
}): Promise<File | null> {
	const response = await fetch(url);
	if (!response.ok) return null;
	const blob = await response.blob();
	return new File([blob], name, {
		type: type || blob.type || "application/octet-stream",
		lastModified: lastModified ?? Date.now(),
	});
}

async function parseRepositoryResponse({
	response,
}: {
	response: Response;
}): Promise<unknown> {
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		const message =
			isObject(data) && typeof data.error === "string"
				? data.error
				: `Shared library repository write failed (${response.status})`;
		throw new Error(message);
	}
	return data;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifestFromApiResult({
	value,
}: {
	value: unknown;
}): SharedLibraryManifest | null {
	if (!isObject(value) || !isObject(value.manifest)) return null;
	return {
		...emptyManifest(),
		...(value.manifest as Partial<SharedLibraryManifest>),
	};
}

function readAudioAssetsFromApiResult({
	value,
}: {
	value: unknown;
}): SharedAudioAsset[] {
	return isObject(value) && Array.isArray(value.assets)
		? (value.assets as SharedAudioAsset[])
		: [];
}

function readStickerAssetsFromApiResult({
	value,
}: {
	value: unknown;
}): SharedStickerAsset[] {
	return isObject(value) && Array.isArray(value.assets)
		? (value.assets as SharedStickerAsset[])
		: [];
}

export class SharedLibraryService {
	private audioMetadata = new LocalDriveJsonAdapter<SharedAudioAsset>({
		collection: "audio",
		legacy: new IndexedDBAdapter<SharedAudioAsset>({
			dbName: "video-editor-shared-audio-assets",
			storeName: "audio-assets",
			version: SHARED_DB_VERSION,
		}),
	});
	private stickerMetadata = new LocalDriveJsonAdapter<SharedStickerAsset>({
		collection: "stickers",
		legacy: new IndexedDBAdapter<SharedStickerAsset>({
			dbName: "video-editor-shared-sticker-assets",
			storeName: "sticker-assets",
			version: SHARED_DB_VERSION,
		}),
	});
	private categories = new LocalDriveJsonAdapter<SharedAssetCategory>({
		collection: "categories",
		legacy: new IndexedDBAdapter<SharedAssetCategory>({
			dbName: "video-editor-shared-asset-categories",
			storeName: "categories",
			version: SHARED_DB_VERSION,
		}),
	});
	private backgrounds = new LocalDriveJsonAdapter<GeneratedBackgroundPreset>({
		collection: "backgrounds",
		legacy: new IndexedDBAdapter<GeneratedBackgroundPreset>({
			dbName: "video-editor-generated-backgrounds",
			storeName: "backgrounds",
			version: SHARED_DB_VERSION,
		}),
	});
	private effects = new LocalDriveJsonAdapter<GeneratedEffectPreset>({
		collection: "effects",
		legacy: new IndexedDBAdapter<GeneratedEffectPreset>({
			dbName: "video-editor-generated-effects",
			storeName: "effects",
			version: SHARED_DB_VERSION,
		}),
	});
	private captionPresets = new LocalDriveJsonAdapter<SharedCaptionPreset>({
		collection: "caption-presets",
		legacy: new IndexedDBAdapter<SharedCaptionPreset>({
			dbName: "video-editor-caption-presets",
			storeName: "caption-presets",
			version: SHARED_DB_VERSION,
		}),
	});
	private audioFiles = new LocalDriveFileAdapter({
		kind: "audio",
		legacy: new OPFSAdapter(AUDIO_FILES_DIR),
	});
	private stickerFiles = new LocalDriveFileAdapter({
		kind: "stickers",
		legacy: new OPFSAdapter(STICKER_FILES_DIR),
	});
	private audioUrlCache = new Map<string, string>();
	private stickerUrlCache = new Map<string, string>();
	private stickerDataUrlCache = new Map<string, string>();

	private async loadRepositoryManifest(): Promise<SharedLibraryManifest> {
		const response = await fetch(SHARED_LIBRARY_API, { cache: "no-store" });
		const data = await parseRepositoryResponse({ response });
		return readManifestFromApiResult({ value: data }) ?? emptyManifest();
	}

	private async patchRepositoryManifest({
		body,
	}: {
		body: unknown;
	}): Promise<SharedLibraryManifest> {
		const response = await fetch(SHARED_LIBRARY_API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = await parseRepositoryResponse({ response });
		return readManifestFromApiResult({ value: data }) ?? emptyManifest();
	}

	private async importRepositoryAudioAsset({
		asset,
		file,
	}: {
		asset: SharedAudioAsset;
		file: File;
	}): Promise<{ asset: SharedAudioAsset; file: File } | null> {
		try {
			const repositoryFile = await cloneStoredFile({
				file,
				name: asset.fileName ?? file.name,
				type: asset.mimeType || file.type || "audio/mpeg",
				lastModified: new Date(asset.updatedAt).getTime(),
			});
			const formData = new FormData();
			formData.set("action", "importAudio");
			formData.set(
				"metadata",
				JSON.stringify([
					{
						...asset,
						fileName: repositoryFile.name,
						mimeType: repositoryFile.type || asset.mimeType,
						size: repositoryFile.size,
						storageKind: "repo",
					},
				]),
			);
			formData.append("files", repositoryFile, repositoryFile.name);

			const response = await fetch(SHARED_LIBRARY_API, {
				method: "POST",
				body: formData,
			});
			const data = await parseRepositoryResponse({ response });
			const [imported] = readAudioAssetsFromApiResult({ value: data });
			return imported ? { asset: imported, file: repositoryFile } : null;
		} catch (error) {
			console.warn("Could not import archive audio into repository:", error);
			return null;
		}
	}

	private async importRepositoryStickerAsset({
		asset,
		file,
	}: {
		asset: SharedStickerAsset;
		file: File;
	}): Promise<{
		asset: SharedStickerAsset;
		file: File;
		dataUrl: string;
	} | null> {
		try {
			const repositoryFile = await cloneStoredFile({
				file,
				name: asset.fileName ?? file.name,
				type: asset.mimeType || file.type || "image/png",
				lastModified: new Date(asset.updatedAt).getTime(),
			});
			const dataUrl = await readFileAsDataUrl({ file: repositoryFile });
			const formData = new FormData();
			formData.set("action", "importStickers");
			formData.set(
				"metadata",
				JSON.stringify([
					{
						...asset,
						fileName: repositoryFile.name,
						mimeType: repositoryFile.type || asset.mimeType,
						size: repositoryFile.size,
						storageKind: "repo",
					},
				]),
			);
			formData.append("files", repositoryFile, repositoryFile.name);

			const response = await fetch(SHARED_LIBRARY_API, {
				method: "POST",
				body: formData,
			});
			const data = await parseRepositoryResponse({ response });
			const [imported] = readStickerAssetsFromApiResult({ value: data });
			return imported
				? { asset: imported, file: repositoryFile, dataUrl }
				: null;
		} catch (error) {
			console.warn("Could not import archive sticker into repository:", error);
			return null;
		}
	}

	private async findAudioAsset({ id }: { id: string }) {
		const assets = await this.listAudioAssets();
		return assets.find((asset) => asset.id === id) ?? null;
	}

	private async findStickerAsset({ id }: { id: string }) {
		const assets = await this.listStickerAssets();
		return assets.find((asset) => asset.id === id) ?? null;
	}

	private async findMatchingAudioAsset({
		asset,
	}: {
		asset: SharedAudioAsset;
	}): Promise<SharedAudioAsset | null> {
		const assets = await this.listAudioAssets();
		return (
			assets.find(
				(existing) =>
					existing.id === asset.id ||
					(Boolean(asset.sourceUrl) &&
						existing.sourceUrl === asset.sourceUrl) ||
					(Boolean(asset.repositoryPath) &&
						existing.repositoryPath === asset.repositoryPath),
			) ?? null
		);
	}

	private async findMatchingStickerAsset({
		asset,
	}: {
		asset: SharedStickerAsset;
	}): Promise<SharedStickerAsset | null> {
		const assets = await this.listStickerAssets();
		return (
			assets.find(
				(existing) =>
					existing.id === asset.id ||
					(Boolean(asset.sourceUrl) &&
						existing.sourceUrl === asset.sourceUrl) ||
					(Boolean(asset.repositoryPath) &&
						existing.repositoryPath === asset.repositoryPath),
			) ?? null
		);
	}

	async listAudioAssets({
		folder,
	}: {
		folder?: SharedAudioFolder;
	} = {}): Promise<SharedAudioAsset[]> {
		const [repositoryManifest, localAssets] = await Promise.all([
			this.loadRepositoryManifest(),
			this.audioMetadata.getAll(),
		]);
		const assets = mergeById({
			repositoryItems: repositoryManifest.audioAssets,
			localItems: localAssets,
		});
		return assets
			.filter((asset) => !folder || asset.folder === folder)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async importAudioFiles({
		files,
		folder,
	}: {
		files: File[];
		folder: SharedAudioFolder;
	}): Promise<SharedAudioAsset[]> {
		const metadata: SharedAudioAsset[] = [];
		const copiedFiles: Array<{ id: string; file: File }> = [];
		for (const file of files) {
			await checkQuota({ file });
			const id = generateUUID();
			const timestamp = nowIso();
			const mimeType = safeMimeType({ file, fallback: "audio/mpeg" });
			const duration = await readAudioDuration({ file });
			const copiedFile = await cloneStoredFile({
				file,
				name: file.name || `${id}.audio`,
				type: mimeType,
				lastModified: Date.now(),
			});
			const asset: SharedAudioAsset = {
				id,
				name: filenameWithoutExtension({ name: file.name || "Audio" }),
				folder,
				mimeType,
				size: file.size,
				...(duration !== null ? { duration } : {}),
				storageKind: "repo",
				createdAt: timestamp,
				updatedAt: timestamp,
			};

			metadata.push(asset);
			copiedFiles.push({ id, file: copiedFile });
		}

		const formData = new FormData();
		formData.set("action", "importAudio");
		formData.set("metadata", JSON.stringify(metadata));
		for (const { file } of copiedFiles) {
			formData.append("files", file, file.name);
		}

		const response = await fetch(SHARED_LIBRARY_API, {
			method: "POST",
			body: formData,
		});
		const data = await parseRepositoryResponse({ response });
		const imported = readAudioAssetsFromApiResult({ value: data });
		for (const asset of imported) {
			const cached = copiedFiles.find((item) => item.id === asset.id);
			if (cached) {
				await this.audioFiles.set({ key: asset.id, value: cached.file });
			}
			await this.audioMetadata.set({ key: asset.id, value: asset });
		}
		return imported;
	}

	async upsertArchiveAudioAsset({
		asset,
		file,
	}: {
		asset: SharedAudioAsset;
		file: File | null;
	}): Promise<{ status: "linked" | "imported"; assetId: string }> {
		const existing = await this.findMatchingAudioAsset({ asset });
		if (existing) {
			return { status: "linked", assetId: existing.id };
		}

		const timestamp = nowIso();
		let normalized: SharedAudioAsset = {
			...asset,
			createdAt: asset.createdAt || timestamp,
			updatedAt: asset.updatedAt || timestamp,
		};

		if (file) {
			const repositoryImport = await this.importRepositoryAudioAsset({
				asset: normalized,
				file,
			});
			if (repositoryImport) {
				await this.audioFiles.set({
					key: repositoryImport.asset.id,
					value: repositoryImport.file,
				});
				await this.audioMetadata.set({
					key: repositoryImport.asset.id,
					value: repositoryImport.asset,
				});
				return { status: "imported", assetId: repositoryImport.asset.id };
			}

			await checkQuota({ file });
			const copiedFile = await cloneStoredFile({
				file,
				name: asset.fileName ?? file.name ?? `${asset.id}.audio`,
				type: asset.mimeType || file.type || "audio/mpeg",
				lastModified: new Date(asset.updatedAt || timestamp).getTime(),
			});
			await this.audioFiles.set({ key: asset.id, value: copiedFile });
			normalized = {
				...normalized,
				fileName: copiedFile.name,
				mimeType: copiedFile.type || normalized.mimeType,
				size: copiedFile.size,
				storageKind: "browser",
				sourceUrl: undefined,
				repositoryPath: undefined,
			};
		}

		await this.audioMetadata.set({ key: normalized.id, value: normalized });
		return { status: "imported", assetId: normalized.id };
	}

	async getAudioAssetFile({ id }: { id: string }): Promise<File | null> {
		const asset = await this.findAudioAsset({ id });
		const file = await this.audioFiles.get(id);
		if (file && asset) {
			return cloneStoredFile({
				file,
				name: asset.fileName ?? asset.name,
				type: asset.mimeType,
				lastModified: new Date(asset.updatedAt).getTime(),
			});
		}
		if (file) return file;
		if (asset?.sourceUrl) {
			return fetchFileFromUrl({
				url: asset.sourceUrl,
				name: asset.fileName ?? asset.name,
				type: asset.mimeType,
				lastModified: new Date(asset.updatedAt).getTime(),
			});
		}
		return null;
	}

	async getAudioAssetUrl({ id }: { id: string }): Promise<string | null> {
		const cached = this.audioUrlCache.get(id);
		if (cached) return cached;
		const asset = await this.findAudioAsset({ id });
		if (asset?.sourceUrl) return asset.sourceUrl;
		const file = await this.getAudioAssetFile({ id });
		if (!file || typeof URL === "undefined") return null;
		const url = URL.createObjectURL(file);
		this.audioUrlCache.set(id, url);
		return url;
	}

	async listStickerAssets(): Promise<SharedStickerAsset[]> {
		const [repositoryManifest, localAssets] = await Promise.all([
			this.loadRepositoryManifest(),
			this.stickerMetadata.getAll(),
		]);
		const assets = mergeById({
			repositoryItems: repositoryManifest.stickerAssets,
			localItems: localAssets,
		});
		return assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async importStickerFiles({
		files,
	}: {
		files: File[];
	}): Promise<SharedStickerAsset[]> {
		const metadata: SharedStickerAsset[] = [];
		const copiedFiles: Array<{ id: string; file: File; dataUrl: string }> = [];
		for (const file of files) {
			await checkQuota({ file });
			const id = generateUUID();
			const timestamp = nowIso();
			const mimeType = safeMimeType({ file, fallback: "image/png" });
			const dataUrl = await readFileAsDataUrl({ file });
			const size = await readImageSize({ dataUrl });
			const copiedFile = await cloneStoredFile({
				file,
				name: file.name || `${id}.sticker`,
				type: mimeType,
				lastModified: Date.now(),
			});
			const asset: SharedStickerAsset = {
				id,
				name: filenameWithoutExtension({ name: file.name || "Sticker" }),
				mimeType,
				size: file.size,
				...(size ? { width: size.width, height: size.height } : {}),
				storageKind: "repo",
				createdAt: timestamp,
				updatedAt: timestamp,
			};

			metadata.push(asset);
			copiedFiles.push({ id, file: copiedFile, dataUrl });
		}

		const formData = new FormData();
		formData.set("action", "importStickers");
		formData.set("metadata", JSON.stringify(metadata));
		for (const { file } of copiedFiles) {
			formData.append("files", file, file.name);
		}

		const response = await fetch(SHARED_LIBRARY_API, {
			method: "POST",
			body: formData,
		});
		const data = await parseRepositoryResponse({ response });
		const imported = readStickerAssetsFromApiResult({ value: data });
		for (const asset of imported) {
			const cached = copiedFiles.find((item) => item.id === asset.id);
			if (cached) {
				await this.stickerFiles.set({ key: asset.id, value: cached.file });
				this.stickerDataUrlCache.set(
					asset.id,
					asset.sourceUrl ?? cached.dataUrl,
				);
			}
			await this.stickerMetadata.set({ key: asset.id, value: asset });
		}
		return imported;
	}

	async upsertArchiveStickerAsset({
		asset,
		file,
	}: {
		asset: SharedStickerAsset;
		file: File | null;
	}): Promise<{ status: "linked" | "imported"; assetId: string }> {
		const existing = await this.findMatchingStickerAsset({ asset });
		if (existing) {
			return { status: "linked", assetId: existing.id };
		}

		const timestamp = nowIso();
		let normalized: SharedStickerAsset = {
			...asset,
			createdAt: asset.createdAt || timestamp,
			updatedAt: asset.updatedAt || timestamp,
		};

		if (file) {
			const repositoryImport = await this.importRepositoryStickerAsset({
				asset: normalized,
				file,
			});
			if (repositoryImport) {
				await this.stickerFiles.set({
					key: repositoryImport.asset.id,
					value: repositoryImport.file,
				});
				this.stickerDataUrlCache.set(
					repositoryImport.asset.id,
					repositoryImport.asset.sourceUrl ?? repositoryImport.dataUrl,
				);
				await this.stickerMetadata.set({
					key: repositoryImport.asset.id,
					value: repositoryImport.asset,
				});
				return { status: "imported", assetId: repositoryImport.asset.id };
			}

			await checkQuota({ file });
			const copiedFile = await cloneStoredFile({
				file,
				name: asset.fileName ?? file.name ?? `${asset.id}.image`,
				type: asset.mimeType || file.type || "image/png",
				lastModified: new Date(asset.updatedAt || timestamp).getTime(),
			});
			const dataUrl = await readFileAsDataUrl({ file: copiedFile });
			await this.stickerFiles.set({ key: asset.id, value: copiedFile });
			this.stickerDataUrlCache.set(asset.id, dataUrl);
			normalized = {
				...normalized,
				fileName: copiedFile.name,
				mimeType: copiedFile.type || normalized.mimeType,
				size: copiedFile.size,
				dataUrl,
				storageKind: "browser",
				sourceUrl: undefined,
				repositoryPath: undefined,
			};
		}

		await this.stickerMetadata.set({ key: normalized.id, value: normalized });
		return { status: "imported", assetId: normalized.id };
	}

	async getStickerAssetFile({ id }: { id: string }): Promise<File | null> {
		const asset = await this.findStickerAsset({ id });
		const file = await this.stickerFiles.get(id);
		if (file && asset) {
			return cloneStoredFile({
				file,
				name: asset.fileName ?? asset.name,
				type: asset.mimeType,
				lastModified: new Date(asset.updatedAt).getTime(),
			});
		}
		if (file) return file;
		if (asset?.sourceUrl) {
			return fetchFileFromUrl({
				url: asset.sourceUrl,
				name: asset.fileName ?? asset.name,
				type: asset.mimeType,
				lastModified: new Date(asset.updatedAt).getTime(),
			});
		}
		return null;
	}

	async getStickerAssetUrl({ id }: { id: string }): Promise<string | null> {
		const cached = this.stickerUrlCache.get(id);
		if (cached) return cached;
		const asset = await this.findStickerAsset({ id });
		if (asset?.sourceUrl) return asset.sourceUrl;
		const file = await this.getStickerAssetFile({ id });
		if (!file || typeof URL === "undefined") return null;
		const url = URL.createObjectURL(file);
		this.stickerUrlCache.set(id, url);
		return url;
	}

	async getStickerAssetDataUrl({ id }: { id: string }): Promise<string | null> {
		const cached = this.stickerDataUrlCache.get(id);
		if (cached) return cached;
		const asset = await this.findStickerAsset({ id });
		if (!asset) return null;
		const url = asset.dataUrl ?? asset.sourceUrl;
		if (!url) return null;
		this.stickerDataUrlCache.set(id, url);
		return url;
	}

	getStickerAssetUrlSync({ id }: { id: string }): string {
		return this.stickerDataUrlCache.get(id) ?? "";
	}

	async warmStickerCache(): Promise<void> {
		const assets = await this.listStickerAssets();
		for (const asset of assets) {
			const url = asset.dataUrl ?? asset.sourceUrl;
			if (url) {
				this.stickerDataUrlCache.set(asset.id, url);
			}
		}
	}

	async listCategories({
		scope,
	}: {
		scope?: SharedCategoryScope;
	} = {}): Promise<SharedAssetCategory[]> {
		const [repositoryManifest, localCategories] = await Promise.all([
			this.loadRepositoryManifest(),
			this.categories.getAll(),
		]);
		const categories = mergeById({
			repositoryItems: repositoryManifest.categories,
			localItems: localCategories,
		});
		return categories
			.filter((category) => !scope || category.scope === scope)
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async createCategory({
		scope,
		name,
	}: {
		scope: SharedCategoryScope;
		name: string;
	}): Promise<SharedAssetCategory> {
		const id = generateUUID();
		const timestamp = nowIso();
		const category: SharedAssetCategory = {
			id,
			scope,
			name: name.trim() || "Untitled",
			assetIds: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.patchRepositoryManifest({
			body: { action: "createCategory", category },
		});
		await this.categories.set({ key: id, value: category });
		return category;
	}

	async addAssetToCategory({
		categoryId,
		assetId,
	}: {
		categoryId: string;
		assetId: string;
	}): Promise<SharedAssetCategory | null> {
		const category =
			(await this.listCategories()).find((item) => item.id === categoryId) ??
			null;
		if (!category) return null;
		if (category.assetIds.includes(assetId)) return category;
		const manifest = await this.patchRepositoryManifest({
			body: { action: "addAssetToCategory", categoryId, assetId },
		});
		const nextCategory = manifest.categories.find(
			(item) => item.id === categoryId,
		) ?? {
			...category,
			assetIds: [...category.assetIds, assetId],
			updatedAt: nowIso(),
		};
		await this.categories.set({ key: categoryId, value: nextCategory });
		return nextCategory;
	}

	async removeAssetFromCategory({
		categoryId,
		assetId,
	}: {
		categoryId: string;
		assetId: string;
	}): Promise<SharedAssetCategory | null> {
		const category =
			(await this.listCategories()).find((item) => item.id === categoryId) ??
			null;
		if (!category) return null;
		const manifest = await this.patchRepositoryManifest({
			body: { action: "removeAssetFromCategory", categoryId, assetId },
		});
		const nextCategory = manifest.categories.find(
			(item) => item.id === categoryId,
		) ?? {
			...category,
			assetIds: category.assetIds.filter((id) => id !== assetId),
			updatedAt: nowIso(),
		};
		await this.categories.set({ key: categoryId, value: nextCategory });
		return nextCategory;
	}

	async listGeneratedBackgrounds(): Promise<GeneratedBackgroundPreset[]> {
		const [repositoryManifest, localPresets] = await Promise.all([
			this.loadRepositoryManifest(),
			this.backgrounds.getAll(),
		]);
		const presets = mergeById({
			repositoryItems: repositoryManifest.generatedBackgrounds,
			localItems: localPresets,
		});
		return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async saveGeneratedBackground({
		name,
		description,
		params,
	}: Omit<
		GeneratedBackgroundPreset,
		"id" | "createdAt" | "updatedAt"
	>): Promise<GeneratedBackgroundPreset> {
		const id = generateUUID();
		const timestamp = nowIso();
		const preset: GeneratedBackgroundPreset = {
			id,
			name,
			description,
			params,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.patchRepositoryManifest({
			body: { action: "saveGeneratedBackground", preset },
		});
		await this.backgrounds.set({ key: id, value: preset });
		return preset;
	}

	async listGeneratedEffects(): Promise<GeneratedEffectPreset[]> {
		const [repositoryManifest, localPresets] = await Promise.all([
			this.loadRepositoryManifest(),
			this.effects.getAll(),
		]);
		const presets = mergeById({
			repositoryItems: repositoryManifest.generatedEffects,
			localItems: localPresets,
		});
		return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async saveGeneratedEffect({
		name,
		description,
		effectType,
		params,
	}: Omit<
		GeneratedEffectPreset,
		"id" | "createdAt" | "updatedAt"
	>): Promise<GeneratedEffectPreset> {
		const id = generateUUID();
		const timestamp = nowIso();
		const preset: GeneratedEffectPreset = {
			id,
			name,
			description,
			effectType,
			params,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await this.patchRepositoryManifest({
			body: { action: "saveGeneratedEffect", preset },
		});
		await this.effects.set({ key: id, value: preset });
		return preset;
	}

	async listCaptionPresets(): Promise<SharedCaptionPreset[]> {
		const [repositoryManifest, localPresets] = await Promise.all([
			this.loadRepositoryManifest(),
			this.captionPresets.getAll(),
		]);
		const presets = mergeById({
			repositoryItems: repositoryManifest.captionPresets,
			localItems: localPresets,
		});
		return presets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	async saveCaptionPreset({
		name,
		settings,
	}: Omit<
		SharedCaptionPreset,
		"id" | "createdAt" | "updatedAt"
	>): Promise<SharedCaptionPreset> {
		const timestamp = nowIso();
		return this.upsertCaptionPreset({
			preset: {
				id: generateUUID(),
				name,
				settings,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		});
	}

	async upsertCaptionPreset({
		preset,
	}: {
		preset: SharedCaptionPreset;
	}): Promise<SharedCaptionPreset> {
		const timestamp = nowIso();
		const normalized: SharedCaptionPreset = {
			...preset,
			name: preset.name.trim() || "Untitled",
			settings: normalizeCaptionLayoutSettings({ settings: preset.settings }),
			createdAt: preset.createdAt || timestamp,
			updatedAt: preset.updatedAt || timestamp,
		};
		await this.patchRepositoryManifest({
			body: { action: "saveCaptionPreset", preset: normalized },
		});
		await this.captionPresets.set({ key: normalized.id, value: normalized });
		return normalized;
	}

	async renameCaptionPreset({
		presetId,
		name,
	}: {
		presetId: string;
		name: string;
	}): Promise<SharedCaptionPreset | null> {
		const current =
			(await this.listCaptionPresets()).find(
				(preset) => preset.id === presetId,
			) ?? null;
		if (!current) return null;

		const updated: SharedCaptionPreset = {
			...current,
			name: name.trim() || current.name,
			updatedAt: nowIso(),
		};
		const manifest = await this.patchRepositoryManifest({
			body: { action: "saveCaptionPreset", preset: updated },
		});
		const saved =
			manifest.captionPresets.find((preset) => preset.id === presetId) ??
			updated;
		await this.captionPresets.set({ key: presetId, value: saved });
		return saved;
	}
}

export const sharedLibraryService = new SharedLibraryService();
