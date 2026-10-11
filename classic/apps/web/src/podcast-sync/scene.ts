import type {
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { roundMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// Multicam scene creation lives in OpenCutRuntime (timeline.classic.multicam.create).
function cloneElementWithOffset({
	element,
	offset,
}: {
	element: TimelineElement;
	offset: MediaTime;
}): TimelineElement {
	return {
		...element,
		id: generateUUID(),
		startTime: roundMediaTime({ time: element.startTime + offset }),
	};
}

function cloneTrackWithOffset<TTrack extends TimelineTrack>({
	track,
	offset,
}: {
	track: TTrack;
	offset: MediaTime;
}): TTrack {
	return {
		...track,
		id: generateUUID(),
		elements: track.elements.map((element) =>
			cloneElementWithOffset({ element, offset }),
		),
	} as TTrack;
}

function mainTrackAsOverlay({
	source,
	offset,
}: {
	source: TScene;
	offset: MediaTime;
}): OverlayTrack[] {
	if (source.tracks.main.elements.length === 0) return [];
	return [
		{
			...cloneTrackWithOffset({ track: source.tracks.main, offset }),
			name: `${source.name} main`,
		},
	];
}

export function unnestSceneTracks({
	targetTracks,
	sourceScene,
	startTime,
}: {
	targetTracks: SceneTracks;
	sourceScene: TScene;
	startTime: MediaTime;
}): SceneTracks {
	const offset = startTime ?? ZERO_MEDIA_TIME;
	const sourceOverlays = [
		...sourceScene.tracks.overlay.map((track) =>
			cloneTrackWithOffset({ track, offset }),
		),
		...mainTrackAsOverlay({ source: sourceScene, offset }),
	];
	const sourceAudio = sourceScene.tracks.audio.map((track) =>
		cloneTrackWithOffset({ track, offset }),
	);

	return {
		...targetTracks,
		overlay: [...sourceOverlays, ...targetTracks.overlay],
		audio: [...targetTracks.audio, ...sourceAudio],
	};
}
