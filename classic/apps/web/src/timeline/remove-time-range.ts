import type {
	SceneTracks,
	TextElement,
	TextWordRun,
	TimelineElement,
	TimelineTrack,
} from "./types";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	type MediaTime,
} from "@/wasm";
import { generateUUID } from "@/utils/id";
import { removeCaptionWordTimeRanges } from "opencut-wasm";

export function removeTimeRangeFromTracks({
	tracks,
	startTime,
	endTime,
	targetElementIds,
}: {
	tracks: SceneTracks;
	startTime: MediaTime;
	endTime: MediaTime;
	/** Updated in place with any fragment IDs created from the targeted elements. */
	targetElementIds?: Set<string>;
}): SceneTracks {
	const duration = Math.max(0, endTime - startTime);
	if (duration <= 0) return tracks;
	const updateTrack = <TTrack extends TimelineTrack>(track: TTrack): TTrack => {
		const elements = track.elements.flatMap((element) => {
			if (targetElementIds && !targetElementIds.has(element.id)) {
				return [element];
			}

			const transformed = removeRangeFromElement({
				element,
				startTime,
				endTime,
				duration,
			});
			if (targetElementIds) {
				targetElementIds.delete(element.id);
				for (const nextElement of transformed) {
					targetElementIds.add(nextElement.id);
				}
			}
			return transformed;
		}) as TTrack["elements"];
		return { ...track, elements };
	};
	const nextTracks: SceneTracks = {
		...tracks,
		overlay: tracks.overlay.map(updateTrack),
		main: updateTrack(tracks.main),
		audio: tracks.audio.map(updateTrack),
	};
	if (targetElementIds) return nextTracks;
	return removeRangeFromCaptionSources({
		tracks: nextTracks,
		startTime,
		endTime,
	});
}

function removeRangeFromElement({
	element,
	startTime,
	endTime,
	duration,
}: {
	element: TimelineElement;
	startTime: MediaTime;
	endTime: MediaTime;
	duration: number;
}): TimelineElement[] {
	const transformed = removeRangeFromElementGeometry({
		element,
		startTime,
		endTime,
		duration,
	});
	if (
		element.type !== "text" ||
		!element.wordRuns?.some(
			(run) => run.startTime != null && run.endTime != null,
		) ||
		element.startTime + element.duration <= startTime ||
		element.startTime >= endTime
	) {
		return transformed;
	}

	return transformed.flatMap<TimelineElement>((nextElement) => {
		if (nextElement.type !== "text") return [nextElement];
		const wordRuns = transformTimedWordRunsForRemovedRange({
			previousElement: element,
			nextElement,
			startTime,
			endTime,
		});
		if (wordRuns.length === 0) return [];
		return [
			{
				...nextElement,
				params: {
					...nextElement.params,
					content: contentFromWordRuns({ wordRuns }),
				},
				wordRuns,
			} satisfies TextElement,
		];
	});
}

function removeRangeFromElementGeometry({
	element,
	startTime,
	endTime,
	duration,
}: {
	element: TimelineElement;
	startTime: MediaTime;
	endTime: MediaTime;
	duration: number;
}): TimelineElement[] {
	const elementStart = element.startTime;
	const elementEnd = element.startTime + element.duration;
	if (elementEnd <= startTime) return [element];
	if (elementStart >= endTime)
		return [
			{ ...element, startTime: mediaTime({ ticks: elementStart - duration }) },
		];
	if (elementStart >= startTime && elementEnd <= endTime) return [];
	if (elementStart < startTime && elementEnd > endTime) {
		if (element.type === "video" || element.type === "audio") {
			const leftDuration = startTime - elementStart;
			const rightDuration = elementEnd - endTime;
			return [
				{
					...element,
					duration: mediaTime({ ticks: leftDuration }),
					trimEnd: mediaTime({
						ticks: element.trimEnd + elementEnd - startTime,
					}),
				},
				{
					...element,
					id: generateUUID(),
					startTime: mediaTime({ ticks: startTime }),
					duration: mediaTime({ ticks: rightDuration }),
					trimStart: mediaTime({
						ticks: element.trimStart + endTime - elementStart,
					}),
				},
			];
		}
		return [
			{
				...element,
				duration: mediaTime({ ticks: element.duration - duration }),
			},
		];
	}
	if (elementStart < startTime)
		return [
			{ ...element, duration: mediaTime({ ticks: startTime - elementStart }) },
		];
	const removedHead = endTime - elementStart;
	return [
		{
			...element,
			startTime: mediaTime({ ticks: startTime }),
			duration: mediaTime({ ticks: elementEnd - endTime }),
			trimStart: mediaTime({ ticks: element.trimStart + removedHead }),
		},
	];
}

function transformTimedWordRunsForRemovedRange({
	previousElement,
	nextElement,
	startTime,
	endTime,
}: {
	previousElement: TextElement;
	nextElement: TextElement;
	startTime: MediaTime;
	endTime: MediaTime;
}): TextWordRun[] {
	const transformedWords = removeCaptionWordTimeRanges({
		words: (previousElement.wordRuns ?? []).flatMap((run, wordIndex) => {
			if (run.startTime == null || run.endTime == null) return [];
			return [
				{
					text: run.text,
					start: mediaTimeToSeconds({
						time: addMediaTime({
							a: previousElement.startTime,
							b: run.startTime,
						}),
					}),
					end: mediaTimeToSeconds({
						time: addMediaTime({
							a: previousElement.startTime,
							b: run.endTime,
						}),
					}),
					source: {
						type: "text-layer",
						trackId: "__element",
						elementId: previousElement.id,
						wordIndex,
						wordId: run.id,
					},
				},
			];
		}),
		ranges: [
			{
				start: mediaTimeToSeconds({ time: startTime }),
				end: mediaTimeToSeconds({ time: endTime }),
			},
		],
	});
	const transformedByIndex = new Map<number, (typeof transformedWords)[number]>(
		transformedWords.flatMap((word) =>
			word.source?.type === "text-layer"
				? ([[word.source.wordIndex, word]] as const)
				: [],
		),
	);
	const nextElementStart = mediaTimeToSeconds({ time: nextElement.startTime });
	const retainedRuns = (previousElement.wordRuns ?? []).flatMap<TextWordRun>(
		(run, wordIndex) => {
			if (run.startTime == null || run.endTime == null) return [run];
			const transformedWord = transformedByIndex.get(wordIndex);
			if (!transformedWord) return [];
			return [
				{
					...run,
					startTime: mediaTimeFromSeconds({
						seconds: Math.max(0, transformedWord.start - nextElementStart),
					}),
					endTime: mediaTimeFromSeconds({
						seconds: Math.max(0, transformedWord.end - nextElementStart),
					}),
				},
			];
		},
	);
	const lineIndexes = [...new Set(retainedRuns.map((run) => run.lineIndex))];
	return retainedRuns.map((run) => ({
		...run,
		lineIndex: lineIndexes.indexOf(run.lineIndex),
	}));
}

function contentFromWordRuns({
	wordRuns,
}: {
	wordRuns: NonNullable<Extract<TimelineElement, { type: "text" }>["wordRuns"]>;
}) {
	const lines = new Map<number, string[]>();
	for (const word of wordRuns) {
		lines.set(word.lineIndex, [
			...(lines.get(word.lineIndex) ?? []),
			word.text,
		]);
	}
	return [...lines.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, words]) => words.join(" "))
		.join("\n");
}

function removeRangeFromCaptionSources({
	tracks,
	startTime,
	endTime,
}: {
	tracks: SceneTracks;
	startTime: MediaTime;
	endTime: MediaTime;
}): SceneTracks {
	const range = {
		start: mediaTimeToSeconds({ time: startTime }),
		end: mediaTimeToSeconds({ time: endTime }),
	};
	return {
		...tracks,
		overlay: tracks.overlay.map((track) => {
			if (track.type !== "text" || !track.captionSource) return track;
			return {
				...track,
				captionSource: {
					...track.captionSource,
					words: removeCaptionWordTimeRanges({
						words: track.captionSource.words,
						ranges: [range],
					}) as typeof track.captionSource.words,
				},
			};
		}),
	};
}
