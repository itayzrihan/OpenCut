import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import type { TimelineTrack } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm/media-time";
import {
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
} from "./layout";
import { getTrackHeight } from "./track-layout";

type TimelineElementRef = { trackId: string; elementId: string };

interface LayoutElement {
	getBoundingClientRect: () => DOMRect;
}

interface ScrollLayoutElement extends LayoutElement {
	scrollLeft: number;
	scrollTop: number;
}

interface SelectionRectangle {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function getNormalizedRectangle({
	startPos,
	endPos,
}: {
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	return {
		left: Math.min(startPos.x, endPos.x),
		top: Math.min(startPos.y, endPos.y),
		right: Math.max(startPos.x, endPos.x),
		bottom: Math.max(startPos.y, endPos.y),
	};
}

function getSelectionRectangleInContent({
	container,
	scrollContainer,
	startPos,
	endPos,
}: {
	container: LayoutElement;
	scrollContainer: ScrollLayoutElement | null;
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	const containerRect = container.getBoundingClientRect();
	const scrollRect = scrollContainer?.getBoundingClientRect() ?? containerRect;
	const scrollLeft = scrollContainer?.scrollLeft ?? 0;
	const scrollTop = scrollContainer?.scrollTop ?? 0;

	const adjustedStart = {
		x: startPos.x - containerRect.left + scrollLeft,
		y: startPos.y - scrollRect.top + scrollTop,
	};
	const adjustedEnd = {
		x: endPos.x - containerRect.left + scrollLeft,
		y: endPos.y - scrollRect.top + scrollTop,
	};

	return getNormalizedRectangle({
		startPos: adjustedStart,
		endPos: adjustedEnd,
	});
}

export function resolveTimelineElementIntersections({
	container,
	scrollContainer,
	tracks,
	zoomLevel,
	startPos,
	currentPos,
	tracksTopInsetPx = TIMELINE_CONTENT_TOP_PADDING_PX,
	getTrackExtraHeight,
}: {
	container: LayoutElement;
	scrollContainer: ScrollLayoutElement | null;
	tracks: TimelineTrack[];
	zoomLevel: number;
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
	tracksTopInsetPx?: number;
	getTrackExtraHeight?: (trackIndex: number) => number;
}): TimelineElementRef[] {
	const selectionRectangle = getSelectionRectangleInContent({
		container,
		scrollContainer,
		startPos,
		endPos: currentPos,
	});
	const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const selectionStartTime =
		(selectionRectangle.left / pixelsPerSecond) * TICKS_PER_SECOND;
	const selectionEndTime =
		(selectionRectangle.right / pixelsPerSecond) * TICKS_PER_SECOND;
	const selectedElements: TimelineElementRef[] = [];
	let trackTop = 0;

	for (const [trackIndex, track] of tracks.entries()) {
		const trackHeight = getTrackHeight({ type: track.type });
		const elementTop = tracksTopInsetPx + trackTop;
		const elementBottom = elementTop + trackHeight;
		const extraHeight = getTrackExtraHeight?.(trackIndex) ?? 0;

		if (
			elementBottom < selectionRectangle.top ||
			elementTop > selectionRectangle.bottom
		) {
			trackTop += trackHeight + extraHeight + TIMELINE_TRACK_GAP_PX;
			continue;
		}

		for (const element of track.elements) {
			const elementEndTime = element.startTime + element.duration;
			if (
				elementEndTime < selectionStartTime ||
				element.startTime > selectionEndTime
			) {
				continue;
			}

			selectedElements.push({
				trackId: track.id,
				elementId: element.id,
			});
		}

		trackTop += trackHeight + extraHeight + TIMELINE_TRACK_GAP_PX;
	}

	return selectedElements;
}
