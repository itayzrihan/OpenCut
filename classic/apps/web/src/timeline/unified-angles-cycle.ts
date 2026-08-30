import type { MediaAsset } from "@/media/types";
import { isUnifiedAnglesAsset } from "@/media/unified-angles";
import type { MediaTime } from "@/wasm";

export interface UnifiedAngleCycleTarget {
	trackId: string;
	elementId: string;
	mediaId: string;
	startTime: MediaTime;
	trackOrder: number;
}

export interface UnifiedAngleCycleUpdate {
	trackId: string;
	elementId: string;
	patch: { unifiedAngleId: string };
}

export function buildUnifiedAngleCycleUpdates({
	asset,
	targets,
	startingAngleAssetId,
}: {
	asset: MediaAsset;
	targets: UnifiedAngleCycleTarget[];
	startingAngleAssetId: string;
}): UnifiedAngleCycleUpdate[] {
	if (!isUnifiedAnglesAsset(asset)) {
		throw new Error("The selected clips do not use a Unified Angles asset");
	}
	if (
		targets.length < 2 ||
		targets.some((target) => target.mediaId !== asset.id)
	) {
		throw new Error(
			"Select at least two clips from the same Unified Angles asset",
		);
	}

	const firstAngleIndex =
		asset.unifiedAngles.angleAssetIds.indexOf(startingAngleAssetId);
	if (firstAngleIndex < 0) {
		throw new Error(
			"The starting camera is not part of this Unified Angles asset",
		);
	}

	return [...targets]
		.sort(
			(left, right) =>
				left.startTime - right.startTime ||
				left.trackOrder - right.trackOrder ||
				left.elementId.localeCompare(right.elementId),
		)
		.map((target, index) => ({
			trackId: target.trackId,
			elementId: target.elementId,
			patch: {
				unifiedAngleId:
					asset.unifiedAngles.angleAssetIds[
						(firstAngleIndex + index) % asset.unifiedAngles.angleAssetIds.length
					],
			},
		}));
}
