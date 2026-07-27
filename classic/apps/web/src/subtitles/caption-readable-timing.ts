import type { TranscriptionWord } from "@/transcription/types";

export const MIN_LAST_WORD_VISIBLE_SECONDS = 0.45;
export const MIN_SINGLE_WORD_VISIBLE_SECONDS = 0.6;

export function getReadableCaptionBounds({
	words,
	startTime,
	endTime,
}: {
	words: TranscriptionWord[];
	startTime: number;
	endTime: number;
}): { startTime: number; endTime: number } {
	const safeEnd = Math.max(endTime, startTime + 0.001);
	if (words.length !== 1) {
		return { startTime, endTime: safeEnd };
	}

	return {
		// A one-word caption has no earlier word inside the layer to provide
		// visual lead-in. Start the layer earlier while keeping its original end.
		startTime: Math.max(
			0,
			Math.min(startTime, safeEnd - MIN_SINGLE_WORD_VISIBLE_SECONDS),
		),
		endTime: safeEnd,
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

	const targetDuration =
		timings.length === 1
			? MIN_SINGLE_WORD_VISIBLE_SECONDS
			: MIN_LAST_WORD_VISIBLE_SECONDS;
	last.start = Math.max(
		captionStartTime,
		Math.min(last.start, last.end - targetDuration),
	);

	const previous = timings[lastIndex - 1];
	if (previous && previous.start + 0.001 < last.start) {
		// Move the visual handoff between the final two words instead of
		// extending the caption beyond the spoken layer.
		previous.end = Math.max(
			previous.start + 0.001,
			Math.min(previous.end, last.start),
		);
	}

	return timings;
}
