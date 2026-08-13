import type { TranscriptionWord } from "@/transcription/types";

export const MIN_LAST_WORD_VISIBLE_SECONDS = 0.45;
export const MIN_SINGLE_WORD_VISIBLE_SECONDS = 0.6;

export function getReadableCaptionBounds({
	words,
	startTime,
	endTime,
	previousCaptionEndTime,
	nextCaptionStartTime,
}: {
	words: TranscriptionWord[];
	startTime: number;
	endTime: number;
	previousCaptionEndTime?: number;
	nextCaptionStartTime?: number;
}): { startTime: number; endTime: number } {
	const safeEnd = Math.max(endTime, startTime + 0.001);
	if (words.length !== 1) {
		return { startTime, endTime: safeEnd };
	}

	const earliestStart = Math.max(0, previousCaptionEndTime ?? 0);
	const latestEnd = Math.max(safeEnd, nextCaptionStartTime ?? safeEnd);
	const missingDuration = Math.max(
		0,
		MIN_SINGLE_WORD_VISIBLE_SECONDS - (safeEnd - startTime),
	);
	const leadIn = Math.min(
		missingDuration,
		Math.max(0, startTime - earliestStart),
	);
	const readableStart = startTime - leadIn;
	const remainingDuration = Math.max(
		0,
		MIN_SINGLE_WORD_VISIBLE_SECONDS - (safeEnd - readableStart),
	);

	return {
		// Prefer a lead-in, then borrow only genuinely free time after the word.
		// Neighboring captions remain the hard boundaries of the reading window.
		startTime: readableStart,
		endTime: Math.min(latestEnd, safeEnd + remainingDuration),
	};
}

export function getReadableWordTimings({
	words,
	captionStartTime,
	captionEndTime,
}: {
	words: TranscriptionWord[];
	captionStartTime: number;
	captionEndTime: number;
}): Array<{ start: number; end: number }> {
	const timings = words.map((word) => ({
		start: Math.max(captionStartTime, word.start),
		end: Math.min(captionEndTime, Math.max(word.start + 0.001, word.end)),
	}));
	const lastIndex = timings.length - 1;
	const last = timings[lastIndex];
	if (!last) return timings;

	if (timings.length === 1) {
		// The layer bounds were already expanded into free neighboring time.
		// Keep its only word visible for that entire non-overlapping window.
		last.start = captionStartTime;
		last.end = captionEndTime;
		return timings;
	}

	const previous = timings[lastIndex - 1];
	const targetStart = last.end - MIN_LAST_WORD_VISIBLE_SECONDS;
	const earliestNonOverlappingStart = Math.max(
		captionStartTime,
		previous?.end ?? captionStartTime,
	);
	last.start = Math.min(
		last.end - 0.001,
		Math.max(
			earliestNonOverlappingStart,
			Math.min(last.start, targetStart),
		),
	);

	return timings;
}
