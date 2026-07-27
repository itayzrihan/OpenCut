import { cloneAnimations } from "@/animation";
import type {
	ElementRef,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/timeline";
import {
	findTrackInSceneTracks,
	getDisplayTracks,
	splitTrackByType,
	updateElementInSceneTracks,
	updateTrackInSceneTracks,
} from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import { generateUUID } from "@/utils/id";
import {
	planBackgroundRemovalDuplicate,
	resolveBackgroundRemovalSettings,
} from "./core";
import type { BackgroundRemovalSettings } from "./types";

export interface BackgroundRemovalEditResult {
	tracks: SceneTracks;
	target: ElementRef;
	createdTrack: boolean;
}

export function buildBackgroundRemovalEdit({
	tracks,
	trackId,
	elementId,
	settings,
	duplicate,
	duplicateElementId = generateUUID(),
	duplicateTrackId = generateUUID(),
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	settings: BackgroundRemovalSettings;
	duplicate: boolean;
	duplicateElementId?: string;
	duplicateTrackId?: string;
}): BackgroundRemovalEditResult | null {
	const sourceTrack = findTrackInSceneTracks({ tracks, trackId });
	const sourceElement = sourceTrack?.elements.find(
		(element) => element.id === elementId,
	);
	if (
		!sourceTrack ||
		sourceTrack.type !== "video" ||
		sourceElement?.type !== "video"
	) {
		return null;
	}

	const resolvedSettings = resolveBackgroundRemovalSettings({ settings });
	const normalizedSettings: BackgroundRemovalSettings = {
		enabled: resolvedSettings.enabled,
		mode: resolvedSettings.mode,
		quality: resolvedSettings.quality,
		maskThreshold: resolvedSettings.maskThreshold,
		edgeContrast: resolvedSettings.edgeContrast,
		edgeFeather: resolvedSettings.edgeFeather,
		temporalSmoothing: resolvedSettings.temporalSmoothing,
		blurStrength: resolvedSettings.blurStrength,
	};

	if (!duplicate) {
		return {
			tracks: updateElementInSceneTracks({
				tracks,
				trackId,
				elementId,
				update: () => ({
					...sourceElement,
					backgroundRemoval: normalizedSettings,
				}),
			}),
			target: { trackId, elementId },
			createdTrack: false,
		};
	}

	const displayTracks = getDisplayTracks({ tracks });
	const sourceTrackIndex = displayTracks.findIndex(
		(track) => track.id === trackId,
	);
	if (sourceTrackIndex < 0) return null;

	const placement = planBackgroundRemovalDuplicate({
		tracks: displayTracks,
		sourceTrackIndex,
		sourceStartTime: sourceElement.startTime,
		sourceDuration: sourceElement.duration,
	});
	const duplicatedElement: VideoElement = {
		...sourceElement,
		id: duplicateElementId,
		name: `${sourceElement.name} (person)`,
		isSourceAudioEnabled: false,
		backgroundRemoval: normalizedSettings,
		animations: cloneAnimations({
			animations: sourceElement.animations,
			shouldRegenerateKeyframeIds: true,
		}),
	};

	if (placement.kind === "existingTrack") {
		const targetTrack = findTrackInSceneTracks({
			tracks,
			trackId: placement.trackId,
		});
		if (!targetTrack || targetTrack.type !== "video") return null;
		return {
			tracks: updateTrackInSceneTracks({
				tracks,
				trackId: targetTrack.id,
				update: (track) => ({
					...track,
					elements: [...track.elements, duplicatedElement],
				}),
			}),
			target: { trackId: targetTrack.id, elementId: duplicatedElement.id },
			createdTrack: false,
		};
	}

	const newTrack: VideoTrack = {
		...buildEmptyTrack({ id: duplicateTrackId, type: "video" }),
		elements: [duplicatedElement],
	};
	return {
		tracks: splitTrackByType({
			tracks,
			track: newTrack,
			insertIndex: placement.insertIndex,
		}),
		target: { trackId: newTrack.id, elementId: duplicatedElement.id },
		createdTrack: true,
	};
}
