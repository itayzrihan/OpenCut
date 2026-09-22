import type { SceneTracks } from "@/timeline/types";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	mediaTime,
	type MediaTime,
} from "@/wasm";
import { rippleResizeWasm } from "./ripple-resize-wasm";

// A timeline splice changes every transcript timestamp in one pass. Element
// editing reconciliation is inappropriate here: matching each moved caption
// against an already moved source can consume another caption's words.
export function rippleCaptionSources({
	tracks,
	cutTime,
	insertedDuration,
}: {
	tracks: SceneTracks;
	cutTime: MediaTime;
	insertedDuration: MediaTime;
}): SceneTracks {
	return {
		...tracks,
		overlay: tracks.overlay.map((track) => {
			if (track.type !== "text" || !track.captionSource) return track;
			const source = track.captionSource;
			const mapped = rippleResizeWasm.rippleInsertTime({
				cutTime,
				insertedDuration,
				clips: source.words.map((word, index) => ({
					id: String(index),
					startTime: mediaTimeFromSeconds({ seconds: word.start }),
					duration: mediaTimeFromSeconds({ seconds: word.end - word.start }),
				})),
			});
			return {
				...track,
				captionSource: {
					...source,
					words: mapped.flatMap((timing, index) => {
						const word = source.words[index];
						if (timing.duration <= 0 && word.end > word.start) return [];
						return [
							{
								...word,
								start: mediaTimeToSeconds({
									time: mediaTime({ ticks: timing.startTime }),
								}),
								end: mediaTimeToSeconds({
									time: mediaTime({
										ticks: timing.startTime + timing.duration,
									}),
								}),
							},
						];
					}),
				},
			};
		}),
	};
}
