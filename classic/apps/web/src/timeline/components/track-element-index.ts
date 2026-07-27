import type { TimelineTrack } from "@/timeline";

export function getTrackIndexByElementId({
	tracks,
}: {
	tracks: TimelineTrack[];
}): ReadonlyMap<string, number> {
	const trackIndexByElementId = new Map<string, number>();

	for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
		for (const element of tracks[trackIndex].elements) {
			trackIndexByElementId.set(element.id, trackIndex);
		}
	}

	return trackIndexByElementId;
}

export function getTrackIndexesForElementIds({
	elementIds,
	trackIndexByElementId,
}: {
	elementIds: Iterable<string>;
	trackIndexByElementId: ReadonlyMap<string, number>;
}): ReadonlySet<number> {
	const trackIndexes = new Set<number>();

	for (const elementId of elementIds) {
		const trackIndex = trackIndexByElementId.get(elementId);
		if (trackIndex !== undefined) {
			trackIndexes.add(trackIndex);
		}
	}

	return trackIndexes;
}
