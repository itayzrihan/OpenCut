import { getDisplayTracks } from "@/timeline/track-order";
import type { SceneTracks, TrackType } from "@/timeline/types";

export function getDefaultInsertIndexForTrack({
	tracks,
	trackType,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
}): number {
	if (trackType === "effect") {
		return 0;
	}

	const displayTracks = getDisplayTracks({ tracks });
	if (trackType === "audio") {
		return displayTracks.length;
	}

	const firstAudioIndex = displayTracks.findIndex(
		(track) => track.type === "audio",
	);
	return firstAudioIndex >= 0 ? firstAudioIndex : displayTracks.length;
}

export function getHighestInsertIndexForTrack({
	tracks: _tracks,
	trackType: _trackType,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
}): number {
	return 0;
}

export function resolvePreferredNewTrackPlacement({
	tracks,
	trackType,
	preferredIndex,
	direction,
}: {
	tracks: SceneTracks;
	trackType: TrackType;
	preferredIndex: number;
	direction: "above" | "below";
}): { insertIndex: number; insertPosition: "above" | "below" | null } {
	const trackCount = getDisplayTracks({ tracks }).length;
	if (trackCount === 0) {
		return {
			insertIndex: 0,
			insertPosition: trackType === "audio" ? "below" : null,
		};
	}

	const safePreferredIndex = Math.min(
		Math.max(preferredIndex, 0),
		trackCount - 1,
	);
	const insertIndex =
		direction === "above" ? safePreferredIndex : safePreferredIndex + 1;
	return {
		insertIndex,
		insertPosition: direction,
	};
}
