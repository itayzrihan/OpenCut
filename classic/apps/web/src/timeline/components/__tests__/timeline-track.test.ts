import { describe, expect, test } from "bun:test";
import type { TextElement, TextTrack } from "@/timeline";
import {
	DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX,
	getElementVisibilityScrollLeft,
	getTimelineElementVisibilityIndex,
	getVisibleTimelineElements,
} from "@/timeline/components/visible-elements";
import {
	mediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm/media-time";

function textElement({
	id,
	startSeconds,
	durationSeconds = 1,
}: {
	id: string;
	startSeconds: number;
	durationSeconds?: number;
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: mediaTime({ ticks: startSeconds * TICKS_PER_SECOND }),
		duration: mediaTime({ ticks: durationSeconds * TICKS_PER_SECOND }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function textTrack({ elements }: { elements: TextElement[] }): TextTrack {
	return {
		id: "track-1",
		name: "Track 1",
		type: "text",
		hidden: false,
		elements,
	};
}

describe("timeline track visibility", () => {
	test("buckets horizontal scroll for overscan-backed visibility", () => {
		expect(
			getElementVisibilityScrollLeft({
				scrollLeft: DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX / 2 - 1,
			}),
		).toBe(0);
		expect(
			getElementVisibilityScrollLeft({
				scrollLeft: DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX / 2,
			}),
		).toBe(DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX / 2);
		expect(
			getElementVisibilityScrollLeft({
				scrollLeft: DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX - 1,
			}),
		).toBe(DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX / 2);
	});

	test("filters elements by visible time range without per-element pixel conversion", () => {
		const track = textTrack({
			elements: [
				textElement({ id: "before", startSeconds: 0, durationSeconds: 1 }),
				textElement({ id: "visible-a", startSeconds: 2, durationSeconds: 1 }),
				textElement({ id: "visible-b", startSeconds: 3, durationSeconds: 1 }),
				textElement({ id: "after", startSeconds: 6, durationSeconds: 1 }),
			],
		});

		expect(
			getVisibleTimelineElements({
				track,
				zoomLevel: 1,
				scrollLeft: 100,
				viewportWidth: 100,
				selectedElementIds: new Set(),
				overscanPx: 0,
			}).map((element) => element.id),
		).toEqual(["visible-a", "visible-b"]);
	});

	test("keeps selected target and dragged elements mounted outside the viewport", () => {
		const track = textTrack({
			elements: [
				textElement({ id: "selected", startSeconds: 0, durationSeconds: 1 }),
				textElement({ id: "visible", startSeconds: 2, durationSeconds: 1 }),
				textElement({ id: "target", startSeconds: 8, durationSeconds: 1 }),
				textElement({ id: "dragged", startSeconds: 10, durationSeconds: 1 }),
				textElement({ id: "hidden", startSeconds: 12, durationSeconds: 1 }),
			],
		});

		expect(
			getVisibleTimelineElements({
				track,
				zoomLevel: 1,
				scrollLeft: 100,
				viewportWidth: 50,
				selectedElementIds: new Set(["selected"]),
				targetElementId: "target",
				draggedElementIds: new Set(["dragged"]),
				overscanPx: 0,
			}).map((element) => element.id),
		).toEqual(["selected", "visible", "target", "dragged"]);
	});

	test("keeps long elements visible when they start before the viewport", () => {
		const track = textTrack({
			elements: [
				textElement({ id: "long", startSeconds: 0, durationSeconds: 20 }),
				textElement({ id: "later", startSeconds: 25, durationSeconds: 1 }),
			],
		});

		expect(
			getVisibleTimelineElements({
				track,
				zoomLevel: 1,
				scrollLeft: 250,
				viewportWidth: 25,
				selectedElementIds: new Set(),
				visibilityIndex: getTimelineElementVisibilityIndex({
					elements: track.elements,
				}),
				overscanPx: 0,
			}).map((element) => element.id),
		).toEqual(["long"]);
	});

	test("preserves filtering behavior when imported elements are not sorted", () => {
		const track = textTrack({
			elements: [
				textElement({ id: "late", startSeconds: 20, durationSeconds: 1 }),
				textElement({ id: "visible", startSeconds: 5, durationSeconds: 1 }),
				textElement({ id: "early", startSeconds: 0, durationSeconds: 1 }),
			],
		});

		expect(
			getVisibleTimelineElements({
				track,
				zoomLevel: 1,
				scrollLeft: 250,
				viewportWidth: 25,
				selectedElementIds: new Set(),
				visibilityIndex: getTimelineElementVisibilityIndex({
					elements: track.elements,
				}),
				overscanPx: 0,
			}).map((element) => element.id),
		).toEqual(["visible"]);
	});
});
