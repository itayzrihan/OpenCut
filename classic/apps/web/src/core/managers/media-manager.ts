import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { localDriveRequest } from "@/services/local-drive/client";

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

	constructor(private editor: EditorCore) {}

	async relink({
		projectId,
		id,
		source,
		undo = false,
	}: {
		projectId: string;
		id: string;
		source: string;
		undo?: boolean;
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
				expectedRevision: asset.bindingRevision ?? 0,
				requestId: generateUUID(),
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

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id"> & { id?: string };
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: asset.id ?? generateUUID(),
		};

		try {
			const publish = this.editor.command.prepareClassicMediaImport({
				projectId,
				assets: [newAsset],
			});
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			publish();
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
