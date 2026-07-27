import { sharedLibraryService } from "@/shared-library";
import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

export const USER_STICKERS_PROVIDER_ID = "user-stickers";

function toStickerItem({
	id,
	name,
	previewUrl,
	width,
	height,
}: {
	id: string;
	name: string;
	previewUrl: string;
	width?: number;
	height?: number;
}): StickerItem {
	return {
		id: buildStickerId({
			providerId: USER_STICKERS_PROVIDER_ID,
			providerValue: id,
		}),
		provider: USER_STICKERS_PROVIDER_ID,
		name,
		previewUrl,
		metadata: {
			sharedAssetId: id,
			width,
			height,
		},
	};
}

async function loadUserStickerItems(): Promise<StickerItem[]> {
	const assets = await sharedLibraryService.listStickerAssets();
	await sharedLibraryService.warmStickerCache();
	return assets.map((asset) =>
		toStickerItem({
			id: asset.id,
			name: asset.name,
			previewUrl: asset.dataUrl ?? asset.sourceUrl ?? "",
			width: asset.width,
			height: asset.height,
		}),
	);
}

export const userStickersProvider: StickerProvider = {
	id: USER_STICKERS_PROVIDER_ID,
	async search({
		query,
		options,
	}: {
		query: string;
		options?: { limit?: number };
	}): Promise<StickerSearchResult> {
		const normalizedQuery = query.trim().toLowerCase();
		const items = (await loadUserStickerItems()).filter((item) =>
			item.name.toLowerCase().includes(normalizedQuery),
		);
		const limit = options?.limit ?? items.length;
		return {
			items: items.slice(0, limit),
			total: items.length,
			hasMore: items.length > limit,
		};
	},
	async browse({
		options,
	}: {
		options?: { page?: number; limit?: number };
	}): Promise<StickerBrowseResult> {
		const items = await loadUserStickerItems();
		const page = Math.max(1, options?.page ?? 1);
		const limit = Math.max(1, options?.limit ?? (items.length || 1));
		const startIndex = (page - 1) * limit;
		const endIndex = startIndex + limit;
		return {
			sections: [
				{
					id: "all",
					items: items.slice(startIndex, endIndex),
					hasMore: endIndex < items.length,
					layout: "grid",
				},
			],
		};
	},
	resolveUrl({ stickerId }: { stickerId: string }): string {
		const { providerValue } = parseStickerId({ stickerId });
		return sharedLibraryService.getStickerAssetUrlSync({ id: providerValue });
	},
};
