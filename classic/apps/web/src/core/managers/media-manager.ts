import type { EditorCore } from "@/core";
import { toast } from "@/i18n/toast";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import {
	assertLocalDriveWriteScope,
	captureLocalDriveWriteScope,
	localDriveRequest,
} from "@/services/local-drive/client";
import { getMediaTypeFromFile } from "@/media/media-utils";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import type { DroppedFileHandles } from "@/media/browser-file-drop";
import { localizeClientMessage } from "@/i18n/client-messages";
import { UnifiedAnglesSyncTasks } from "@/media/unified-sync-task";
import { isUnifiedAnglesAsset } from "@/media/unified-angles";

export class MediaManager {
	private assetViews: MediaAsset[] = [];
	private get assets(): MediaAsset[] {
		return this.assetViews;
	}
	private set assets(assets: MediaAsset[]) {
		this.editor.command.synchronizeMedia({ assets });
		this.assetViews = assets;
	}
	private isLoading = false;
	private listeners = new Set<() => void>();

	private unifiedSync: UnifiedAnglesSyncTasks;
	constructor(private editor: EditorCore) {
		this.unifiedSync = new UnifiedAnglesSyncTasks({
			editor,
			onSettled: () => this.notify(),
		});
	}

	syncUnifiedAngles(input: { projectId: string; mediaId: string }) {
		return this.unifiedSync.start(input);
	}
	async createUnifiedWithAudio({ mediaIds }: { mediaIds: string[] }) {
		const projectId = this.editor.project.getActive().metadata.id;
		const created = this.editor.command.createUnifiedWithAudio(mediaIds);
		await storageService.saveMediaAsset({ projectId, mediaAsset: created });
		await this.editor.command.flushHistory();
		// Creation is native; host only persists metadata and runs local decoding.
		void this.syncUnifiedAngles({ projectId, mediaId: created.id });
		return created;
	}

	isUnifiedAnglesSyncing(mediaId: string) {
		return this.unifiedSync.isRunning(mediaId);
	}

	async relink({
		projectId,
		id,
		source,
		undo = false,
		requestId,
		expectedRevision,
	}: {
		projectId: string;
		id: string;
		source: string;
		undo?: boolean;
		requestId?: string;
		expectedRevision?: number;
	}) {
		const asset = this.assets.find((item) => item.id === id);
		if (!asset || this.editor.project.getActive()?.metadata.id !== projectId)
			throw new Error("Open the target project before relinking");
		await localDriveRequest({
			operation: undo ? "media.relink.undo" : "media.relink",
			payload: {
				projectId,
				id,
				source,
				expectedRevision: expectedRevision ?? asset.bindingRevision ?? 0,
				requestId: requestId ?? generateUUID(),
			},
		});
		videoCache.clearVideo({ mediaId: id });
		waveformCache.clearAll();
		const refreshed = await storageService.loadMediaAsset({ projectId, id });
		if (
			refreshed &&
			this.editor.project.getActive()?.metadata.id === projectId
		) {
			this.assets = this.assets.map((item) =>
				item.id === id ? refreshed : item,
			);
			this.notify();
		}
	}

	private browserImports = new Map<string, Promise<MediaAsset | null>>();

	isPreparingBrowserMedia(id: string) {
		return this.browserImports.has(id);
	}

	/** Publish the file references in one canonical Undo entry before reading bytes. */
	importBrowserFiles({
		projectId,
		files,
		handles,
	}: {
		projectId: string;
		files: File[];
		handles?: DroppedFileHandles;
	}): Promise<MediaAsset | null>[] {
		if (!isHostedBrowserWorkspace())
			throw new Error("Browser media import requires a hosted workspace");
		const scope = captureLocalDriveWriteScope({ projectId });
		const assets = files.flatMap((file) => {
			const type = getMediaTypeFromFile({ file });
			if (!type) {
				toast.error(
					localizeClientMessage("Unsupported file type: {v0}", {
						v0: file.name,
					}),
				);
				return [];
			}
			return [
				{
					id: generateUUID(),
					type,
					file,
					name: file.name,
					fileName: file.name,
					mimeType: file.type,
					size: file.size,
					lastModified: file.lastModified,
					url: URL.createObjectURL(file),
					storageKind: "copied" as const,
				},
			];
		});
		if (!assets.length) return [];
		try {
			this.editor.command.prepareClassicMediaImport({ projectId, assets })();
		} catch (error) {
			for (const asset of assets) URL.revokeObjectURL(asset.url);
			throw error;
		}
		const sameProject = () => {
			assertLocalDriveWriteScope({ projectId, scope });
			return this.editor.project.getActiveOrNull()?.metadata.id === projectId;
		};
		// A single probe at a time avoids starting a decoder for every dropped file.
		let probing: Promise<unknown> = Promise.resolve();
		return assets.map((asset) => {
			const stored: MediaAsset = { ...asset };
			const saving = (async () => {
				const handle = await handles?.get(asset.file);
				try {
					Object.assign(
						stored,
						await storageService.saveBrowserMediaAsset({
							projectId,
							mediaAsset: stored,
							scope,
							fileHandle: handle,
						}),
					);
				} catch (error) {
					if (
						!(
							handle &&
							error instanceof DOMException &&
							error.name === "DataCloneError"
						)
					)
						throw error;
					Object.assign(
						stored,
						await storageService.saveBrowserMediaAsset({
							projectId,
							mediaAsset: stored,
							scope,
						}),
					);
				}
			})().then(
				() => true,
				(error: unknown) => {
					console.error("Browser media could not be saved:", error);
					if (window.__opencutAccountId === scope.accountId)
						toast.error(
							localizeClientMessage(
								"Could not keep {v0} after closing this tab",
								{ v0: asset.name },
							),
							{
								description: error instanceof Error ? error.message : undefined,
							},
						);
					return false;
				},
			);
			const ready = probing
				.then(async () => {
					if (
						!sameProject() ||
						!this.assets.some((item) => item.id === asset.id)
					)
						return null;
					const { probeBrowserMedia } = await import("@/media/processing");
					const metadata = await probeBrowserMedia({
						asset,
						signal: AbortSignal.timeout(15_000),
					});
					if (!sameProject()) return null;
					const current = this.assets.find((item) => item.id === asset.id);
					if (!current) return null;
					const updated = { ...current, ...metadata };
					this.setAssets({
						assets: this.assets.map((item) =>
							item.id === asset.id ? updated : item,
						),
					});
					if (updated.type === "video" && updated.fps)
						this.editor.project.ratchetFpsForImportedMedia({
							importedAssets: [updated],
						});
					void saving
						.then(async (saved) => {
							if (!saved) return;
							await storageService.updateBrowserMediaMetadata({
								projectId,
								id: asset.id,
								metadata,
								scope,
							});
							if (!sameProject()) return;
							if (stored.storageKind === "linked") {
								this.setAssets({
									assets: this.assets.map((item) =>
										item.id === asset.id
											? { ...item, storageKind: "linked" }
											: item,
									),
								});
							}
							if (this.editor.command.hasAtomicSessionStorage())
								await this.editor.command.persistEditingSession();
						})
						.catch((error: unknown) =>
							console.error("Could not save browser media metadata:", error),
						);
					return updated;
				})
				.catch((error: unknown) => {
					console.error("Could not read browser media:", error);
					if (window.__opencutAccountId === scope.accountId)
						toast.error(
							localizeClientMessage("Couldn't process {v0}", {
								v0: asset.name,
							}),
							{
								description: error instanceof Error ? error.message : undefined,
							},
						);
					return null;
				})
				.finally(() => {
					this.browserImports.delete(asset.id);
					this.notify();
				});
			probing = ready;
			this.browserImports.set(asset.id, ready);
			return ready;
		});
	}

	async reopenBrowserSource({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}) {
		const scope = captureLocalDriveWriteScope({ projectId });
		const asset = await storageService.loadMediaAsset({
			projectId,
			id,
			requestBrowserAccess: true,
		});
		assertLocalDriveWriteScope({ projectId, scope });
		if (!asset || asset.missing)
			throw new Error(
				"The original file is unavailable. Import it again if it was moved or changed.",
			);
		if (this.editor.project.getActiveOrNull()?.metadata.id !== projectId)
			return;
		this.setAssets({
			assets: this.assets.map((item) => (item.id === id ? asset : item)),
		});
		if (this.editor.command.hasAtomicSessionStorage())
			await this.editor.command.persistEditingSession();
	}

	async addMediaAsset({
		projectId,
		asset,
		afterRegister,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id"> & { id?: string };
		afterRegister?: (asset: MediaAsset) => undefined;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: asset.id ?? generateUUID(),
		};

		try {
			const publish = this.editor.command.prepareClassicMediaImport({
				projectId,
				assets: [newAsset],
				afterRegister: afterRegister
					? () => afterRegister(newAsset)
					: undefined,
			});
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			publish();
			if (isUnifiedAnglesAsset(newAsset))
				void this.syncUnifiedAngles({ projectId, mediaId: newAsset.id });
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			// Saved bytes are retained after a stale/cancelled publication, never
			// deleted or injected into a different project. Membership is canonical.

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		this.editor.command.removeClassicMedia({ projectId, mediaIds: uniqueIds });
		// Canonical removal retains durable files and URL handles for history.
		// Discard only derived decode caches after the successful transaction.
		for (const id of uniqueIds) {
			videoCache.clearVideo({ mediaId: id });
			waveformCache.clearSource({
				sourceKey: buildWaveformSourceKey({ kind: "media", id }),
			});
		}
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.unifiedSync.cancelAll();
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.unifiedSync.cancelAll();
		this.editor.command.synchronizeMedia({ assets: [], dryRun: true });
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		this.unifiedSync.cancelAll();
		this.editor.command.synchronizeMedia({ assets: [], dryRun: true });
		videoCache.clearAll();
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
