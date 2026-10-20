import {
	podcastCameraClock,
	unifiedCameraRange,
	unifiedCameraSourcesCurrent,
} from "opencut-wasm";
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
	if (
		assets.length < 2 ||
		assets.length > 32 ||
		assets.some(
			(asset) => asset.type !== "video" || isUnifiedAnglesAsset(asset),
		)
	) {
		throw new Error("Select at least two video files to unify");
	}
	const angleAssetIds = assets.map((asset) => asset.id);
	if (new Set(angleAssetIds).size !== angleAssetIds.length) {
		throw new Error("Unified Angles requires different video files");
	}
	const clock = podcastCameraClock({
		sources: assets.map((asset) => ({
			id: asset.id,
			duration: asset.duration ?? 0,
			start: 0,
			bindingRevision: asset.bindingRevision ?? 0,
		})),
	});
	if (!clock) throw new Error("Every camera needs a known recording duration");
	const defaultAsset = assets.find((asset) => asset.id === clock.referenceId)!;
	const audioAsset =
		defaultAsset.hasAudio !== false
			? defaultAsset
			: assets.find((asset) => asset.hasAudio !== false);
	if (!audioAsset) {
		throw new Error("At least one selected video must contain audio");
	}

	return {
		name:
			name?.trim() ||
			(assets.length === 2
				? `${defaultAsset.name} + ${assets.find((asset) => asset.id !== defaultAsset.id)!.name}`
				: `${defaultAsset.name} + ${assets.length - 1} angles`),
		type: "video",
		size: 0,
		lastModified: Date.now(),
		fileName: `${defaultAsset.name} + ${assets.length - 1} angles.unified-angles`,
		mimeType: "application/vnd.opencut.unified-angles",
		storageKind: "copied",
		sourcePath: "",
		width: defaultAsset.width,
		height: defaultAsset.height,
		duration: clock.duration,
		fps: defaultAsset.fps,
		hasAudio: true,
		thumbnailUrl: defaultAsset.thumbnailUrl,
		unifiedAngles: {
			version: 1,
			angleAssetIds,
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
	if (
		asset.unifiedAngles.audioFinishingVersion === 1 &&
		unifiedAnglesSyncStatus({ asset, mediaMap }) !== "synced"
	)
		return null;
	return mediaMap.get(asset.unifiedAngles.audioAssetId) ?? null;
}

export function unifiedAnglesSyncStatus({
	asset,
	mediaMap,
}: {
	asset: MediaAsset;
	mediaMap: ReadonlyMap<string, MediaAsset>;
}): "synced" | "unsynced" | "stale" {
	const sync = asset.unifiedAngles?.sync;
	if (!sync) return "unsynced";
	return unifiedCameraSourcesCurrent({
		recorded: sync.sources,
		current: sync.sources.flatMap((source) => {
			const asset = mediaMap.get(source.id);
			return asset && !asset.missing
				? [
						{
							id: asset.id,
							duration: asset.duration ?? 0,
							start: 0,
							bindingRevision: asset.bindingRevision ?? 0,
						},
					]
				: [];
		}),
	})
		? "synced"
		: "stale";
}

/** Host adapter to the shared Rust source-range policy (all units are seconds). */
export function getUnifiedAngleRange({
	asset,
	angleAssetId,
	mediaMap,
	trimStart,
	duration,
}: {
	asset: MediaAsset;
	angleAssetId?: string;
	mediaMap: ReadonlyMap<string, MediaAsset>;
	trimStart: number;
	duration: number;
}) {
	const id =
		angleAssetId ?? asset.unifiedAngles?.defaultAngleAssetId ?? asset.id;
	const source = mediaMap.get(id);
	const status = unifiedAnglesSyncStatus({ asset, mediaMap });
	const syncSource =
		status === "synced"
			? asset.unifiedAngles?.sync?.sources.find((s) => s.id === id)
			: undefined;
	const range = unifiedCameraRange({
		source: {
			id,
			duration: source?.duration ?? 0,
			start: syncSource?.start ?? 0,
			bindingRevision: source?.bindingRevision ?? 0,
		},
		trimStart,
		duration,
	});
	return {
		...range,
		available:
			range.available &&
			!source?.missing &&
			(!asset.unifiedAngles ||
				(asset.unifiedAngles.angleAssetIds.includes(id) &&
					(id === asset.unifiedAngles.defaultAngleAssetId ||
						status === "synced"))),
	};
}

export function resolveUnifiedAnglesVideoTiming({
	asset,
	element,
	mediaMap,
}: {
	asset: MediaAsset;
	element: import("@/timeline").VideoElement;
	mediaMap: ReadonlyMap<string, MediaAsset>;
}): { asset: MediaAsset; trimStart: number; trimEnd: number } | null {
	if (!isUnifiedAnglesAsset(asset))
		return { asset, trimStart: element.trimStart, trimEnd: element.trimEnd };
	const duration =
		(element.sourceDuration
			? element.sourceDuration - element.trimStart - element.trimEnd
			: element.duration) / 120000;
	for (const id of new Set([
		element.unifiedAngleId ?? asset.unifiedAngles.defaultAngleAssetId,
		asset.unifiedAngles.defaultAngleAssetId,
	])) {
		const range = getUnifiedAngleRange({
			asset,
			angleAssetId: id,
			mediaMap,
			trimStart: element.trimStart / 120000,
			duration,
		});
		const source = mediaMap.get(id);
		if (range.available && source)
			return {
				asset: source,
				trimStart: Math.round(range.sourceStart * 120000),
				trimEnd: Math.max(
					0,
					Math.round(((source.duration ?? 0) - range.sourceEnd) * 120000),
				),
			};
	}
	return null;
}
