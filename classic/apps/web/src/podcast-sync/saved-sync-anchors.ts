import type { MediaAsset } from "@/media/types";
import { unifiedAnglesSyncStatus } from "@/media/unified-angles";

export function savedPodcastAnchors({
	assets,
	referenceId,
	videoIds,
}: {
	assets: MediaAsset[];
	referenceId: string;
	videoIds: Set<string>;
}) {
	const mediaMap = new Map(assets.map((asset) => [asset.id, asset]));
	const proposals = new Map<string, number[]>();
	for (const asset of assets) {
		const sources = asset.unifiedAngles?.sync?.sources;
		if (!sources || unifiedAnglesSyncStatus({ asset, mediaMap }) !== "synced")
			continue;
		const reference = sources.find(({ id }) => id === referenceId);
		if (reference?.start == null) continue;
		for (const source of sources) {
			if (!videoIds.has(source.id) || source.start == null) continue;
			const offsets = proposals.get(source.id) ?? [];
			offsets.push(source.start - reference.start);
			proposals.set(source.id, offsets);
		}
	}
	return new Map(
		[...proposals].flatMap(([id, offsets]) =>
			Math.max(...offsets) - Math.min(...offsets) <= 0.06
				? [
						[
							id,
							offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length,
						] as const,
					]
				: [],
		),
	);
}
