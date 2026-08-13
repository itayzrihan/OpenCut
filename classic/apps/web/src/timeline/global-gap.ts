import { addMediaTime, mediaTime, type MediaTime } from "@/wasm";
import { getDisplayTracks } from "./track-order";
import type { SceneTracks } from "./types";

export type GlobalTimelineGap = {
	startTime: MediaTime;
	endTime: MediaTime;
};

export function findGlobalTimelineGapAtTime({
	tracks,
	time,
}: {
	tracks: SceneTracks;
	time: MediaTime;
}): GlobalTimelineGap | null {
	let previousEnd = mediaTime({ ticks: 0 });
	let nextStart: MediaTime | null = null;

	for (const track of getDisplayTracks({ tracks })) {
		for (const element of track.elements) {
			const elementEnd = addMediaTime({
				a: element.startTime,
				b: element.duration,
			});
			if (element.startTime <= time && elementEnd > time) {
				return null;
			}
			if (elementEnd <= time && elementEnd > previousEnd) {
				previousEnd = elementEnd;
			}
			if (
				element.startTime > time &&
				(nextStart === null || element.startTime < nextStart)
			) {
				nextStart = element.startTime;
			}
		}
	}

	if (nextStart === null || nextStart <= previousEnd) {
		return null;
	}
	return { startTime: previousEnd, endTime: nextStart };
}

export function isExactGlobalTimelineGap({
	tracks,
	startTime,
	endTime,
}: {
	tracks: SceneTracks;
	startTime: MediaTime;
	endTime: MediaTime;
}): boolean {
	if (endTime <= startTime) return false;
	const probeTime = mediaTime({
		ticks: startTime + Math.floor((endTime - startTime) / 2),
	});
	const gap = findGlobalTimelineGapAtTime({ tracks, time: probeTime });
	return gap?.startTime === startTime && gap.endTime === endTime;
}
