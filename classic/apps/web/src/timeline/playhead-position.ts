import {
	getCenteredLineLeft,
	timelineTimeToSnappedPixels,
} from "./pixel-utils";
import type { MediaTime } from "@/wasm/media-time";

export function getPlayheadLeftPx({
	time,
	zoomLevel,
	scrollLeft,
}: {
	time: MediaTime;
	zoomLevel: number;
	scrollLeft: number;
}): number {
	const centerPixel = timelineTimeToSnappedPixels({
		time,
		zoomLevel,
	});
	return getCenteredLineLeft({ centerPixel }) - scrollLeft;
}
