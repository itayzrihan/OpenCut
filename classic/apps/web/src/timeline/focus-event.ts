import type { MediaTime } from "@/wasm";

export const TIMELINE_SCROLL_TO_TIME_EVENT = "opencut:timeline-scroll-to-time";

export interface TimelineScrollToTimeDetail {
	time: MediaTime;
}

export function requestTimelineScrollToTime({
	time,
}: TimelineScrollToTimeDetail) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent<TimelineScrollToTimeDetail>(
			TIMELINE_SCROLL_TO_TIME_EVENT,
			{ detail: { time } },
		),
	);
}
