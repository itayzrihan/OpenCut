import type { MediaTime } from "@/wasm";

export type TimelineRangeSelectionMode =
	| "idle"
	| "armed"
	| "selecting"
	| "selected";

export interface TimelineRangeSelection {
	mode: TimelineRangeSelectionMode;
	startTime: MediaTime | null;
	endTime: MediaTime | null;
	anchorTime: MediaTime | null;
	isTimelineLocked: boolean;
	isPromptOpen: boolean;
}

export interface NormalizedTimelineRange {
	startTime: MediaTime;
	endTime: MediaTime;
	duration: number;
}

export const IDLE_TIMELINE_RANGE_SELECTION: TimelineRangeSelection = {
	mode: "idle",
	startTime: null,
	endTime: null,
	anchorTime: null,
	isTimelineLocked: false,
	isPromptOpen: false,
};

export function normalizeTimelineRange({
	startTime,
	endTime,
}: {
	startTime: MediaTime;
	endTime: MediaTime;
}): NormalizedTimelineRange {
	const normalizedStart = startTime <= endTime ? startTime : endTime;
	const normalizedEnd = startTime <= endTime ? endTime : startTime;
	return {
		startTime: normalizedStart,
		endTime: normalizedEnd,
		duration: normalizedEnd - normalizedStart,
	};
}

export function getSelectedTimelineRange(
	state: TimelineRangeSelection,
): NormalizedTimelineRange | null {
	if (state.startTime === null || state.endTime === null) {
		return null;
	}

	const range = normalizeTimelineRange({
		startTime: state.startTime,
		endTime: state.endTime,
	});
	return range.duration > 0 ? range : null;
}
