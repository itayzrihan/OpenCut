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
	if (insertedDuration === 0) return selectedUpdates;

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

		// Map words through the same timeline edit. Passing them explicitly also
		// prevents a pure ripple move from being interpreted as trimming text.
		const wordRuns =
			element.type === "text" && element.wordRuns
				? element.wordRuns.flatMap((word) => {
						if (word.startTime == null || word.endTime == null) return [word];
						const [mapped] = rippleResizeWasm.rippleInsertTime({
							clips: [
								{
									id: word.id,
									startTime: element.startTime + word.startTime,
									duration: word.endTime - word.startTime,
								},
							],
							cutTime,
							insertedDuration,
						});
						if (mapped.duration <= 0 && word.endTime > word.startTime)
							return [];
						return [
							{
								...word,
								startTime: mediaTime({
									ticks: mapped.startTime - timing.startTime,
								}),
								endTime: mediaTime({
									ticks: mapped.startTime + mapped.duration - timing.startTime,
								}),
							},
						];
					})
				: undefined;
		const textPatch =
			element.type === "text" && wordRuns
				? {
						wordRuns,
						params: {
							...element.params,
							content: wordRuns
								.map(
									(word, index) =>
										`${index === 0 ? "" : word.lineIndex === wordRuns[index - 1].lineIndex ? " " : "\n"}${word.text}`,
								)
								.join(""),
						},
					}
				: {};

		return [
			{
				trackId,
				elementId: element.id,
				patch: {
					...textPatch,
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
