import type {
	AudioTrack,
	EffectTrack,
	GraphicTrack,
	OverlayTrack,
	SceneTracks,
	TextTrack,
	TimelineElement,
	VideoTrack,
} from "@/timeline";
import { getDisplayTracks, splitTrackByType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { buildEmptyTrack } from "./track-factory";
import type { PlacementResult } from "./types";
import { updateTrackInSceneTracks } from "@/timeline/track-element-update";

export function applyPlacement({
	tracks,
	placementResult,
	elements,
	newTrackInsertIndexOverride,
}: {
	tracks: SceneTracks;
	placementResult: PlacementResult;
	elements: TimelineElement[];
	newTrackInsertIndexOverride?: number;
}): { updatedTracks: SceneTracks; targetTrackId: string } | null {
	const orderedTracks = getDisplayTracks({ tracks });
	if (placementResult.kind === "existingTrack") {
		const targetTrack = orderedTracks[placementResult.trackIndex];
		if (!targetTrack) {
			return null;
		}

		const updatedTracks = updateTrackInSceneTracks({
			tracks,
			trackId: targetTrack.id,
			update: (track) => ({
				...track,
				elements: [...track.elements, ...elements],
			}),
		});

		return { updatedTracks, targetTrackId: targetTrack.id };
	}

	const newTrackId = generateUUID();
	const insertIndex =
		newTrackInsertIndexOverride ?? placementResult.insertIndex;
	const updatedTracks = splitTrackByType({
		tracks,
		insertIndex,
		track:
			placementResult.trackType === "audio"
				? buildPlacedAudioTrack({
						id: newTrackId,
						elements,
					})
				: buildPlacedOverlayTrack({
						id: newTrackId,
						type: placementResult.trackType,
						elements,
					}),
	});
	return { updatedTracks, targetTrackId: newTrackId };
}

function buildPlacedAudioTrack({
	id,
	elements,
}: {
	id: string;
	elements: TimelineElement[];
}): AudioTrack {
	return {
		...buildEmptyTrack({ id, type: "audio" }),
		elements: elements as AudioTrack["elements"],
	};
}

function buildPlacedOverlayTrack({
	id,
	type,
	elements,
}: {
	id: string;
	type: Exclude<OverlayTrack["type"], "audio">;
	elements: TimelineElement[];
}): OverlayTrack {
	switch (type) {
		case "video":
			return {
				...buildEmptyTrack({ id, type: "video" }),
				elements: elements as VideoTrack["elements"],
			};
		case "text":
			return {
				...buildEmptyTrack({ id, type: "text" }),
				elements: elements as TextTrack["elements"],
			};
		case "graphic":
			return {
				...buildEmptyTrack({ id, type: "graphic" }),
				elements: elements as GraphicTrack["elements"],
			};
		case "effect":
			return {
				...buildEmptyTrack({ id, type: "effect" }),
				elements: elements as EffectTrack["elements"],
			};
	}
}
