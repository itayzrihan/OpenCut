import { resolveStickerId } from "@/stickers";
import { parseStickerId } from "@/stickers/sticker-id";
import { sharedLibraryService } from "@/shared-library";
import { USER_STICKERS_PROVIDER_ID } from "@/stickers/providers/user-stickers";
import {
	VisualNode,
	type ResolvedVisualSourceNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface StickerNodeParams extends VisualNodeParams {
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}

interface CachedStickerSource {
	source: HTMLImageElement;
	width: number;
	height: number;
}

const stickerSourceCache = new Map<string, Promise<CachedStickerSource>>();

export function loadStickerSource({
	stickerId,
}: {
	stickerId: string;
}): Promise<CachedStickerSource> {
	const cached = stickerSourceCache.get(stickerId);
	if (cached) return cached;

	const promise = (async (): Promise<CachedStickerSource> => {
		const url = resolveStickerId({
			stickerId,
			options: { width: 200, height: 200 },
		});
		const resolvedUrl =
			url ||
			(parseStickerId({ stickerId }).providerId === USER_STICKERS_PROVIDER_ID
				? await sharedLibraryService.getStickerAssetDataUrl({
						id: parseStickerId({ stickerId }).providerValue,
					})
				: null);
		if (!resolvedUrl) {
			throw new Error(`Failed to resolve sticker: ${stickerId}`);
		}

		const image = new Image();

		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () =>
				reject(new Error(`Failed to load sticker: ${stickerId}`));
			image.src = resolvedUrl;
		});

		return {
			source: image,
			width: image.naturalWidth,
			height: image.naturalHeight,
		};
	})();

	stickerSourceCache.set(stickerId, promise);
	return promise;
}

export class StickerNode extends VisualNode<
	StickerNodeParams,
	ResolvedVisualSourceNodeState
> {}
