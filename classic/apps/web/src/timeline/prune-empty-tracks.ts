import type { SceneTracks } from "@/timeline/types";

/**
 * Remove ordinary tracks after their last element is deleted. Parallax tracks
 * are hierarchy markers by design, so being empty is their valid persisted
 * state and must not make them eligible for pruning.
 */
export function pruneEmptyElementTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	return {
		...tracks,
		overlay: tracks.overlay.filter(
			(track) => track.type === "parallax" || track.elements.length > 0,
		),
		audio: tracks.audio.filter((track) => track.elements.length > 0),
	};
}
