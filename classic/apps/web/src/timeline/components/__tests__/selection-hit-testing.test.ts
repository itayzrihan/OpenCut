import { describe, expect, test } from "bun:test";
import type { TextElement, TimelineTrack, VideoElement } from "@/timeline";
import { resolveTimelineElementIntersections } from "@/timeline/components/selection-hit-testing";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

function makeDomRect({
	left,
	top,
	width,
	height,
}: {
	left: number;
	top: number;
	width: number;
	height: number;
}): DOMRect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	};
}

function makeContainer({
	left = 0,
	top = 0,
	width = 1000,
	height = 500,
}: {
	left?: number;
	top?: number;
	width?: number;
	height?: number;
}) {
	return {
		getBoundingClientRect: () => makeDomRect({ left, top, width, height }),
	};
}

function makeScrollContainer({
	left = 0,
	top = 0,
	scrollLeft = 0,
	scrollTop = 0,
	width = 1000,
	height = 500,
}: {
	left?: number;
	top?: number;
	scrollLeft?: number;
	scrollTop?: number;
	width?: number;
	height?: number;
}) {
	return {
		scrollLeft,
		scrollTop,
		getBoundingClientRect: () => makeDomRect({ left, top, width, height }),
	};
}

function makeTextElement({
	id,
	startSeconds = 0,
	durationSeconds = 5,
}: {
	id: string;
	startSeconds?: number;
	durationSeconds?: number;
}): TextElement {
	return {
		id,
		name: id,
		type: "text",
		startTime: mediaTimeFromSeconds({ seconds: startSeconds }),
		duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

function makeVideoElement({ id }: { id: string }): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "media-1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTimeFromSeconds({ seconds: 5 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

describe("timeline element hit testing", () => {
	test("uses the rendered top inset when the word timing row is visible", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "text-track",
				name: "Text",
				type: "text",
				hidden: false,
				elements: [makeTextElement({ id: "text-1" })],
			},
			{
				id: "video-track",
				name: "Video",
				type: "video",
				muted: false,
				hidden: false,
				elements: [makeVideoElement({ id: "video-1" })],
			},
		];

		const hits = resolveTimelineElementIntersections({
			container: makeContainer({}),
			scrollContainer: makeScrollContainer({}),
			tracks,
			zoomLevel: 1,
			tracksTopInsetPx: 50,
			startPos: { x: 5, y: 52 },
			currentPos: { x: 100, y: 70 },
		});

		expect(hits).toEqual([{ trackId: "text-track", elementId: "text-1" }]);
	});

	test("uses expanded track heights before later tracks", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "expanded-text-track",
				name: "Expanded text",
				type: "text",
				hidden: false,
				elements: [makeTextElement({ id: "expanded-text-1" })],
			},
			{
				id: "target-text-track",
				name: "Target text",
				type: "text",
				hidden: false,
				elements: [makeTextElement({ id: "target-text-1" })],
			},
			{
				id: "video-track",
				name: "Video",
				type: "video",
				muted: false,
				hidden: false,
				elements: [makeVideoElement({ id: "video-1" })],
			},
		];

		const hits = resolveTimelineElementIntersections({
			container: makeContainer({}),
			scrollContainer: makeScrollContainer({}),
			tracks,
			zoomLevel: 1,
			tracksTopInsetPx: 10,
			getTrackExtraHeight: (trackIndex) => (trackIndex === 0 ? 40 : 0),
			startPos: { x: 5, y: 83 },
			currentPos: { x: 100, y: 100 },
		});

		expect(hits).toEqual([
			{ trackId: "target-text-track", elementId: "target-text-1" },
		]);
	});

	test("filters horizontally using the scroll-adjusted selection time range", () => {
		const tracks: TimelineTrack[] = [
			{
				id: "text-track",
				name: "Text",
				type: "text",
				hidden: false,
				elements: [
					makeTextElement({
						id: "before",
						startSeconds: 0,
						durationSeconds: 1,
					}),
					makeTextElement({
						id: "target",
						startSeconds: 4,
						durationSeconds: 1,
					}),
					makeTextElement({
						id: "after",
						startSeconds: 8,
						durationSeconds: 1,
					}),
				],
			},
		];

		const hits = resolveTimelineElementIntersections({
			container: makeContainer({}),
			scrollContainer: makeScrollContainer({ scrollLeft: 150 }),
			tracks,
			zoomLevel: 1,
			tracksTopInsetPx: 10,
			startPos: { x: 40, y: 12 },
			currentPos: { x: 110, y: 30 },
		});

		expect(hits).toEqual([{ trackId: "text-track", elementId: "target" }]);
	});
});
