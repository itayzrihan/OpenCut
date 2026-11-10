import { z } from "zod";
import { sharedLibraryService } from "@/shared-library/service";
import { accountNamespace, isHostedBrowserWorkspace } from "@/accounts/browser";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { localDriveRequest } from "@/services/local-drive/client";

export type SharedExchangeKind = "sharedAudio" | "sharedSticker";
export interface SharedExchangeAsset {
	kind: SharedExchangeKind;
	id: string;
	name: string;
	fileName: string;
	mimeType: string;
	size: number;
	lastModified: number;
	metadata: Record<string, unknown>;
	getFile: () => Promise<File | null>;
}
const metadataSchema = z.object({
	id: z.string().min(1).max(256),
	name: z.string().min(1).max(1024),
	fileName: z.string().max(1024).optional(),
	mimeType: z.string().min(1).max(128),
	size: z.number().int().nonnegative(),
	createdAt: z
		.string()
		.max(80)
		.refine((s) => Number.isFinite(Date.parse(s)))
		.optional(),
	updatedAt: z
		.string()
		.max(80)
		.refine((s) => Number.isFinite(Date.parse(s)))
		.optional(),
	folder: z.enum(["sfx", "music"]).optional(),
	duration: z.number().finite().nonnegative().optional(),
	width: z.number().int().positive().max(32768).optional(),
	height: z.number().int().positive().max(32768).optional(),
	sha256: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	pack: z.string().max(1024).optional(),
	license: z
		.object({
			status: z.enum(["commercial-use-verified", "needs-review"]),
			licenseId: z.string().max(2048).optional(),
			licenseUrl: z.string().max(4096).optional(),
			sourcePage: z.string().max(4096).optional(),
			author: z.string().max(2048).optional(),
			verifiedAt: z.string().max(128).optional(),
			attributionRequired: z.boolean().optional(),
			note: z.string().max(8192).optional(),
		})
		.optional(),
});

function activeAccount() {
	const id = typeof window === "undefined" ? null : window.__opencutAccountId;
	if (!id) throw new Error("Sign in before transferring shared assets");
	return id;
}
function assertScope({
	accountId,
	signal,
}: {
	accountId: string;
	signal?: AbortSignal;
}) {
	signal?.throwIfAborted();
	if (activeAccount() !== accountId)
		throw new Error("Account changed during shared asset transfer");
}
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Read-only dependency discovery over current and historical canonical documents. */
export async function collectSharedExchangeAssets(
	documents: unknown[],
): Promise<SharedExchangeAsset[]> {
	const accountId = activeAccount();
	const audio = new Set<string>(),
		stickers = new Set<string>();
	const pending: unknown[] = [...documents];
	const visited = new WeakSet<object>();
	let nodes = 0;
	while (pending.length) {
		const item = pending.pop();
		if (item === null || typeof item !== "object" || visited.has(item))
			continue;
		if (++nodes > 2_000_000)
			throw new Error("Shared asset document exceeds its scan limit");
		visited.add(item);
		if (Array.isArray(item)) {
			for (const child of item) pending.push(child);
			continue;
		}
		const value = record(item)!;
		if (
			value.type === "audio" &&
			value.sourceType === "library" &&
			value.librarySourceType === "shared" &&
			typeof value.libraryAssetId === "string"
		)
			audio.add(value.libraryAssetId);
		if (
			value.type === "sticker" &&
			typeof value.stickerId === "string" &&
			value.stickerId.startsWith("user-stickers:")
		)
			stickers.add(value.stickerId.slice("user-stickers:".length));
		for (const child of Object.values(value)) pending.push(child);
	}
	if (!audio.size && !stickers.size) return [];
	const [audioAssets, stickerAssets] = await Promise.all([
		audio.size ? sharedLibraryService.listAudioAssets() : [],
		stickers.size ? sharedLibraryService.listStickerAssets() : [],
	]);
	assertScope({ accountId });
	const result: SharedExchangeAsset[] = [];
	for (const kind of ["sharedAudio", "sharedSticker"] as const) {
		const assets = kind === "sharedAudio" ? audioAssets : stickerAssets;
		const ids = kind === "sharedAudio" ? audio : stickers;
		for (const id of ids) {
			const original = assets.find((asset) => asset.id === id);
			const metadata = metadataSchema.parse(
				original ?? {
					id,
					name: id,
					mimeType: kind === "sharedAudio" ? "audio/mpeg" : "image/png",
					size: 0,
				},
			);
			result.push({
				kind,
				id,
				name: metadata.name,
				fileName: metadata.fileName ?? metadata.name,
				mimeType: metadata.mimeType,
				size: metadata.size,
				lastModified: Date.parse(metadata.updatedAt ?? "1970-01-01T00:00:00Z"),
				metadata,
				getFile: async () => {
					assertScope({ accountId });
					if (!original) return null;
					const file =
						kind === "sharedAudio"
							? await sharedLibraryService.getAudioAssetFile({ id })
							: await sharedLibraryService.getStickerAssetFile({ id });
					assertScope({ accountId });
					return file;
				},
			});
		}
	}
	return result;
}

/** Import bytes under a fresh ID; imported locators never authorize reads or alias existing assets. */
export async function importSharedExchangeAsset({
	kind,
	metadata,
	file,
	signal,
}: {
	kind: SharedExchangeKind;
	metadata: Record<string, unknown>;
	file: File | null;
	signal?: AbortSignal;
}): Promise<string> {
	const accountId = activeAccount();
	assertScope({ accountId, signal });
	const parsed = metadataSchema.parse(metadata);
	const audio = kind === "sharedAudio";
	if (!audio && kind !== "sharedSticker")
		throw new Error("Invalid shared asset type");
	if (!parsed.mimeType.startsWith(audio ? "audio/" : "image/"))
		throw new Error("Shared asset media type differs from its category");
	if (
		file &&
		(file.size !== parsed.size || (file.type && file.type !== parsed.mimeType))
	)
		throw new Error("Shared asset bytes differ from the archive descriptor");
	const id = crypto.randomUUID();
	const collection = audio ? "audio" : "stickers";
	const hosted = isHostedBrowserWorkspace();
	let dataUrl: string | undefined;
	if (file && (parsed.sha256 || !audio)) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (parsed.sha256) {
			const hash = [
				...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
			]
				.map((v) => v.toString(16).padStart(2, "0"))
				.join("");
			if (hash !== parsed.sha256)
				throw new Error("Shared asset checksum mismatch");
		}
		if (!audio) {
			let binary = "";
			for (let offset = 0; offset < bytes.length; offset += 8192)
				binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
			dataUrl = `data:${parsed.mimeType};base64,${btoa(binary)}`;
		}
	}
	assertScope({ accountId, signal });
	const stamp = new Date().toISOString();
	const value = {
		...parsed,
		id,
		visibility: "account",
		storageKind: hosted ? "browser" : "account",
		fileName: parsed.fileName ?? file?.name ?? parsed.name,
		createdAt: parsed.createdAt ?? stamp,
		updatedAt: parsed.updatedAt ?? stamp,
		...(audio ? { folder: parsed.folder ?? "sfx" } : { dataUrl }),
	};
	if (hosted) {
		// Pin directory and IndexedDB names before any await; account switching cannot redirect writes.
		const directoryName = accountNamespace(
			`hosted-shared-files-${collection}`,
			accountId,
		);
		if (file) {
			const root = await navigator.storage.getDirectory();
			const directory = await root.getDirectoryHandle(directoryName, {
				create: true,
			});
			const handle = await directory.getFileHandle(id, { create: true });
			const writable = await handle.createWritable();
			try {
				await writable.write(file);
				await writable.close();
			} catch (error) {
				await writable.abort().catch(() => {});
				throw error;
			}
		}
		assertScope({ accountId, signal });
		await new IndexedDBAdapter<Record<string, unknown>>({
			dbName: `hosted-shared-${collection}`,
			storeName: "records",
			accountId,
		}).set({ key: id, value });
	} else {
		if (file) {
			const query = new URLSearchParams({
				kind: collection,
				id,
				mimeType: parsed.mimeType,
				account: accountId,
			});
			const response = await fetch("/api/local-drive/shared-file?" + query, {
				method: "POST",
				body: file,
				signal,
				headers: { "X-OpenCut-Account": accountId },
			});
			if (!response.ok)
				throw new Error(`Could not import shared asset (${response.status})`);
		}
		assertScope({ accountId, signal });
		await localDriveRequest({
			operation: "shared.put",
			payload: { collection, id, value },
			scope: { accountId, signal },
		});
	}
	assertScope({ accountId, signal });
	return id;
}
