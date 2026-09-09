import { getDisplayTracks } from "@/timeline/track-order";
import type { SceneTracks } from "@/timeline/types";
import { mediaTime, type MediaTime } from "@/wasm";
import { rippleResizeWasm } from "./ripple-resize-wasm";
import type { GroupResizeUpdate } from "./types";

export function buildRippleResizeUpdates({
	tracks,
	selectedUpdates,
	cutTime,
	insertedDuration,
}: {
	tracks: SceneTracks;
	selectedUpdates: GroupResizeUpdate[];
	cutTime: MediaTime;
	insertedDuration: MediaTime;
}): GroupResizeUpdate[] {
	if (insertedDuration <= 0) return selectedUpdates;

	const selectedIds = new Set(
		selectedUpdates.map((update) => update.elementId),
	);
	const entries = getDisplayTracks({ tracks }).flatMap((track) =>
		track.elements.flatMap((element) =>
			selectedIds.has(element.id) ? [] : [{ trackId: track.id, element }],
		),
	);
	const timingById = new Map(
		rippleResizeWasm
			.rippleInsertTime({
				clips: entries.map(({ element }) => ({
					id: element.id,
					startTime: element.startTime,
					duration: element.duration,
				})),
				cutTime,
				insertedDuration,
			})
			.map((timing) => [timing.id, timing]),
	);

	const companionUpdates = entries.flatMap(({ trackId, element }) => {
		const timing = timingById.get(element.id);
		if (
			!timing ||
			(timing.startTime === element.startTime &&
				timing.duration === element.duration)
		) {
			return [];
		}

		return [
			{
				trackId,
				elementId: element.id,
				patch: {
					trimStart: element.trimStart,
					trimEnd: element.trimEnd,
					startTime: mediaTime({ ticks: timing.startTime }),
					duration: mediaTime({ ticks: timing.duration }),
				},
			},
		];
	});

	return [...selectedUpdates, ...companionUpdates];
}
