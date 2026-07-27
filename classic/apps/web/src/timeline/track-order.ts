import type {
	AudioTrack,
	OverlayTrack,
	SceneTracks,
	TimelineTrack,
	TrackType,
} from "./types";

export function getDefaultTrackOrder({ tracks }: { tracks: SceneTracks }): string[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio].map((track) => track.id);
}

export function getAllTracksById({
	tracks,
}: {
	tracks: SceneTracks;
}): Map<string, TimelineTrack> {
	return new Map(
		[...tracks.overlay, tracks.main, ...tracks.audio].map((track) => [
			track.id,
			track,
		]),
	);
}

export function getDisplayTrackIds({
	tracks,
}: {
	tracks: SceneTracks;
}): string[] {
	const tracksById = getAllTracksById({ tracks });
	const seen = new Set<string>();
	const orderedIds: string[] = [];

	for (const trackId of tracks.order ?? []) {
		if (!tracksById.has(trackId) || seen.has(trackId)) {
			continue;
		}
		seen.add(trackId);
		orderedIds.push(trackId);
	}

	for (const trackId of getDefaultTrackOrder({ tracks })) {
		if (seen.has(trackId)) {
			continue;
		}
		orderedIds.push(trackId);
	}

	return orderedIds;
}

export function getDisplayTracks({
	tracks,
}: {
	tracks: SceneTracks;
}): TimelineTrack[] {
	const tracksById = getAllTracksById({ tracks });
	return getDisplayTrackIds({ tracks }).flatMap((trackId) => {
		const track = tracksById.get(trackId);
		return track ? [track] : [];
	});
}

export function getTrackDisplayIndex({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): number {
	return getDisplayTrackIds({ tracks }).indexOf(trackId);
}

export function withNormalizedTrackOrder({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	return {
		...tracks,
		order: getDisplayTrackIds({ tracks }),
	};
}

export function withInsertedTrackOrder({
	tracks,
	trackId,
	insertIndex,
}: {
	tracks: SceneTracks;
	trackId: string;
	insertIndex: number;
}): SceneTracks {
	const order = getDisplayTrackIds({ tracks }).filter((id) => id !== trackId);
	const safeIndex = Math.max(0, Math.min(insertIndex, order.length));
	order.splice(safeIndex, 0, trackId);
	return { ...tracks, order };
}

export function withRemovedTrackOrder({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): SceneTracks {
	return {
		...tracks,
		order: getDisplayTrackIds({ tracks }).filter((id) => id !== trackId),
	};
}

export function withReorderedTrack({
	tracks,
	trackId,
	toIndex,
}: {
	tracks: SceneTracks;
	trackId: string;
	toIndex: number;
}): SceneTracks {
	const order = getDisplayTrackIds({ tracks });
	const fromIndex = order.indexOf(trackId);
	if (fromIndex < 0) {
		return withNormalizedTrackOrder({ tracks });
	}

	const [removed] = order.splice(fromIndex, 1);
	const safeIndex = Math.max(0, Math.min(toIndex, order.length));
	order.splice(safeIndex, 0, removed);
	return { ...tracks, order };
}

export function splitTrackByType({
	tracks,
	track,
	insertIndex,
}: {
	tracks: SceneTracks;
	track: TimelineTrack;
	insertIndex: number;
}): SceneTracks {
	const nextTracks =
		track.type === "audio"
			? insertAudioTrack({ tracks, track, insertIndex })
			: insertOverlayTrack({ tracks, track, insertIndex });
	return withInsertedTrackOrder({
		tracks: nextTracks,
		trackId: track.id,
		insertIndex,
	});
}

function insertAudioTrack({
	tracks,
	track,
	insertIndex,
}: {
	tracks: SceneTracks;
	track: AudioTrack;
	insertIndex: number;
}): SceneTracks {
	const audioIds = new Set(tracks.audio.map((audioTrack) => audioTrack.id));
	const orderedBefore = getDisplayTrackIds({ tracks })
		.slice(0, insertIndex)
		.filter((trackId) => audioIds.has(trackId));
	const audioInsertIndex = Math.max(
		0,
		Math.min(orderedBefore.length, tracks.audio.length),
	);
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, audioInsertIndex),
			track,
			...tracks.audio.slice(audioInsertIndex),
		],
	};
}

function insertOverlayTrack({
	tracks,
	track,
	insertIndex,
}: {
	tracks: SceneTracks;
	track: OverlayTrack;
	insertIndex: number;
}): SceneTracks {
	const overlayIds = new Set(tracks.overlay.map((overlayTrack) => overlayTrack.id));
	const orderedBefore = getDisplayTrackIds({ tracks })
		.slice(0, insertIndex)
		.filter((trackId) => overlayIds.has(trackId));
	const overlayInsertIndex = Math.max(
		0,
		Math.min(orderedBefore.length, tracks.overlay.length),
	);
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			track,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}

export function canCreateTrackTypeAtDisplayIndex({
	trackType,
}: {
	trackType: TrackType;
}): boolean {
	return trackType === "audio" || trackType === "video" || trackType === "text" || trackType === "graphic" || trackType === "effect";
}
