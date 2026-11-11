import type { BrowserFileHandle } from "@/media/browser-file-handle";
import type { HyperframesImportDraft } from "@/hyperframes/import-recovery-types";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import type { MediaAssetData } from "./types";

type BrowserMedia = MediaAssetData & {
	file?: File;
	fileHandle?: BrowserFileHandle;
	revision: string;
	uploadToken?: string;
	deleted?: boolean;
};

type BrowserImport = {
	id: string;
	createdAt: string;
	draft: HyperframesImportDraft;
};

const objectUrls = new Map<string, { revision: string; url: string }>();

export function hostedMedia(
	projectId: string,
	accountId = window.__opencutAccountId,
) {
	if (!accountId) throw new Error("Sign in before opening account storage");
	const dbName = `hosted-media-${projectId}`;
	const records = new IndexedDBAdapter<BrowserMedia>({
		dbName,
		storeName: "media",
		accountId,
	});
	const imports = new IndexedDBAdapter<BrowserImport>({
		dbName: `${dbName}-imports`,
		storeName: "imports",
		accountId,
	});
	const keyPrefix = JSON.stringify([accountId, projectId]).slice(0, -1) + ",";
	const readImport = async (uploadToken: string) => {
		const job = await imports.get(uploadToken);
		if (!job) throw new Error("This import is no longer pending");
		const readyAssetIds: string[] = [];
		for (const { id, size } of job.draft.resources) {
			const record = await records.get(id);
			if (
				!record?.deleted &&
				record?.uploadToken === uploadToken &&
				record.file?.size === size
			)
				readyAssetIds.push(id);
		}
		return {
			uploadToken,
			createdAt: job.createdAt,
			draft: job.draft,
			readyAssetIds,
		};
	};
	const urlFor = (record: BrowserMedia) => {
		if (!record.file) return undefined;
		const key = keyPrefix + JSON.stringify(record.id) + "]";
		const prior = objectUrls.get(key);
		if (prior?.revision === record.revision) return prior.url;
		if (prior) URL.revokeObjectURL(prior.url);
		const url = URL.createObjectURL(record.file);
		objectUrls.set(key, { revision: record.revision, url });
		return url;
	};
	return {
		records,
		imports,
		async hydrate({
			record,
			requestAccess = false,
		}: {
			record: BrowserMedia;
			requestAccess?: boolean;
		}): Promise<MediaAsset> {
			const {
				revision: _revision,
				uploadToken: _uploadToken,
				deleted: _deleted,
				fileHandle,
				...asset
			} = record;
			if (fileHandle) {
				try {
					if (
						requestAccess &&
						fileHandle.requestPermission &&
						(await fileHandle.requestPermission({ mode: "read" })) !== "granted"
					)
						return { ...asset, missing: true };
					const file = await fileHandle.getFile();
					if (
						file.size !== record.size ||
						file.lastModified !== record.lastModified
					)
						return { ...asset, missing: true };
					return {
						...asset,
						file,
						missing: false,
						url: urlFor({ ...record, file }),
					};
				} catch {
					return { ...asset, missing: true };
				}
			}
			return { ...asset, url: urlFor(record) };
		},
		async save({
			asset,
			uploadToken,
			fileHandle,
		}: {
			asset: MediaAsset;
			uploadToken?: string;
			fileHandle?: BrowserFileHandle;
		}) {
			const previous = await records.get(asset.id);
			if (
				uploadToken &&
				(!(await imports.get(uploadToken)) ||
					(previous && previous.uploadToken !== uploadToken))
			) {
				throw new Error("This media import is no longer pending");
			}
			const file = asset.file ?? previous?.file;
			const record: BrowserMedia = {
				id: asset.id,
				name: asset.name,
				type: asset.type,
				size: file?.size ?? asset.size ?? 0,
				lastModified: file?.lastModified ?? asset.lastModified ?? Date.now(),
				fileName: file?.name ?? asset.fileName ?? asset.name,
				mimeType: file?.type || asset.mimeType || "application/octet-stream",
				storageKind: fileHandle ? "linked" : "copied",
				width: asset.width,
				height: asset.height,
				duration: asset.duration,
				fps: asset.fps,
				hasAudio: asset.hasAudio,
				thumbnailUrl: asset.thumbnailUrl,
				ephemeral: asset.ephemeral,
				unifiedAngles: asset.unifiedAngles,
				missing: !fileHandle && !file && !asset.unifiedAngles,
				file: fileHandle ? undefined : file,
				fileHandle,
				revision:
					asset.file && asset.file !== previous?.file
						? crypto.randomUUID()
						: (previous?.revision ?? crypto.randomUUID()),
				uploadToken,
			};
			await records.set({ key: asset.id, value: record });
			return {
				size: record.size,
				lastModified: record.lastModified,
				missing: record.missing,
				sourcePath: undefined,
				storageKind: record.storageKind,
				url: asset.url?.startsWith("blob:")
					? asset.url
					: urlFor({ ...record, file }),
			};
		},
		async beginImport(uploadToken: string, draft: HyperframesImportDraft) {
			const previous = await imports.get(uploadToken);
			if (previous) {
				if (JSON.stringify(previous.draft) !== JSON.stringify(draft))
					throw new Error("The saved import does not match this request");
				return;
			}
			await imports.set({
				key: uploadToken,
				value: { id: uploadToken, draft, createdAt: new Date().toISOString() },
			});
		},
		readImport,
		async listImports() {
			const jobs = await imports.getAll();
			return Promise.all(
				jobs
					.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
					.map(async (job) => {
						const { readyAssetIds, draft } = await readImport(job.id);
						return {
							uploadToken: job.id,
							createdAt: job.createdAt,
							name: draft.name,
							sceneId: draft.sceneId,
							completed: readyAssetIds.length,
							total: draft.resources.length,
						};
					}),
			);
		},
		async finishImport(uploadToken: string, discard: boolean) {
			const job = await imports.get(uploadToken);
			if (!job) return;
			for (const { id } of job.draft.resources) {
				const record = await records.get(id);
				if (record?.uploadToken !== uploadToken) continue;
				if (discard) await records.remove(id);
				else
					await records.set({
						key: id,
						value: { ...record, uploadToken: undefined },
					});
			}
			await imports.remove(uploadToken);
		},
		async clear() {
			await Promise.all([records.clear(), imports.clear()]);
			for (const [key, entry] of objectUrls) {
				if (!key.startsWith(keyPrefix)) continue;
				URL.revokeObjectURL(entry.url);
				objectUrls.delete(key);
			}
		},
	};
}
