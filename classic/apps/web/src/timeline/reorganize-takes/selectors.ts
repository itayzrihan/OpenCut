import {
	findCaptionSourceTrack,
	getGeneratedCaptionWords,
} from "@/subtitles/caption-tracks";
import type { SceneTracks } from "@/timeline/types";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTimeToSeconds, type MediaTime } from "@/wasm";

/** Transcription in this app runs over the whole scene, so "transcribed" is scene-wide. */
export function hasSceneTranscript({ tracks }: { tracks: SceneTracks }): boolean {
	return findCaptionSourceTrack({ tracks }) !== null;
}

/**
 * Generated (non-user-edited) transcript words whose midpoint falls within a clip's time range,
 * sorted chronologically — mirrors the windowing `removeAllSilence` already uses to attribute
 * scene-wide transcript words to a single selected clip. Returns the exact word references from
 * the caption source so callers can identify them by reference later.
 */
export function getTranscriptWordsInRange({
	tracks,
	startTime,
	endTime,
}: {
	tracks: SceneTracks;
	startTime: MediaTime;
	endTime: MediaTime;
}): TranscriptionWord[] {
	const source = findCaptionSourceTrack({ tracks })?.captionSource;
	if (!source) return [];
	const startSeconds = mediaTimeToSeconds({ time: startTime });
	const endSeconds = mediaTimeToSeconds({ time: endTime });
	return getGeneratedCaptionWords({ words: source.words })
		.filter((word) => {
			const midpoint = (word.start + word.end) / 2;
			return midpoint >= startSeconds && midpoint < endSeconds;
		})
		.sort((left, right) => left.start - right.start);
}
