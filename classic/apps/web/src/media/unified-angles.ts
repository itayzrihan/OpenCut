import type { MediaAsset } from "@/media/types";

export function isUnifiedAnglesAsset(
	asset: MediaAsset | null | undefined,
): asset is MediaAsset & {
	unifiedAngles: NonNullable<MediaAsset["unifiedAngles"]>;
} {
	return asset?.unifiedAngles?.version === 1;
}

export function createUnifiedAnglesAsset({
	assets,
	name,
}: {
	assets: MediaAsset[];
	name?: string;
}): Omit<MediaAsset, "id"> {
	if (assets.length !== 2 || assets.some((asset) => asset.type !== "video")) {
		throw new Error("Select exactly two video files to unify");
	}
	if (assets[0].id === assets[1].id) {
		throw new Error("Unified Angles requires two different video files");
	}
	const audioAsset = assets.find((asset) => asset.hasAudio !== false);
	if (!audioAsset) {
		throw new Error("At least one selected video must contain audio");
	}
	const defaultAsset = assets[0];
	const durations = assets
		.map((asset) => asset.duration)
		.filter((duration): duration is number => duration != null);

	return {
		name: name?.trim() || `${defaultAsset.name} + ${assets[1].name}`,
		type: "video",
		size: 0,
		lastModified: Date.now(),
		fileName: `${defaultAsset.name} + ${assets[1].name}.unified-angles`,
		mimeType: "application/vnd.opencut.unified-angles",
		storageKind: "copied",
		sourcePath: "",
		width: defaultAsset.width,
		height: defaultAsset.height,
		duration: durations.length > 0 ? Math.min(...durations) : undefined,
		fps: defaultAsset.fps,
		hasAudio: true,
		thumbnailUrl: defaultAsset.thumbnailUrl,
		unifiedAngles: {
			version: 1,
			angleAssetIds: [assets[0].id, assets[1].id],
			defaultAngleAssetId: defaultAsset.id,
			audioAssetId: audioAsset.id,
		},
	};
}

export function resolveUnifiedAnglesVideoAsset({
	asset,
	angleAssetId,
	mediaMap,
}: {
	asset: MediaAsset;
	angleAssetId?: string;
	mediaMap: ReadonlyMap<string, MediaAsset>;
}): MediaAsset | null {
	if (!isUnifiedAnglesAsset(asset)) return asset;
	const selectedId =
		angleAssetId && asset.unifiedAngles.angleAssetIds.includes(angleAssetId)
			? angleAssetId
			: asset.unifiedAngles.defaultAngleAssetId;
	return mediaMap.get(selectedId) ?? null;
}

export function resolveUnifiedAnglesAudioAsset({
	asset,
	mediaMap,
}: {
	asset: MediaAsset;
	mediaMap: ReadonlyMap<string, MediaAsset>;
}): MediaAsset | null {
	if (!isUnifiedAnglesAsset(asset)) return asset;
	return mediaMap.get(asset.unifiedAngles.audioAssetId) ?? null;
}
