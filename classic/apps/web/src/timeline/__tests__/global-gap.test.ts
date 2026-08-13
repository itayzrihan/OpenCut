import { describe, expect, test } from "bun:test";
import {
	findGlobalTimelineGapAtTime,
	isExactGlobalTimelineGap,
} from "@/timeline/global-gap";
import type {
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline/types";
import type { MediaTime } from "@/wasm";

function time(ticks: number): MediaTime {
	return ticks as MediaTime;
}

function element({
	id,
	start,
	duration,
}: {
	id: string;
	start: number;
	duration: number;
}): TimelineElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "media",
		startTime: time(start),
		duration: time(duration),
		trimStart: time(0),
		trimEnd: time(0),
		params: {},
	} as TimelineElement;
}

function videoTrack({
	id,
	elements,
}: {
	id: string;
	elements: TimelineElement[];
}): TimelineTrack {
	return {
		id,
		name: id,
		type: "video",
		muted: false,
		hidden: false,
		elements,
	} as TimelineTrack;
}

function sceneTracks({
	mainElements = [],
	overlayElements = [],
}: {
	mainElements?: TimelineElement[];
	overlayElements?: TimelineElement[];
}): SceneTracks {
	return {
		main: videoTrack({
			id: "main",
			elements: mainElements,
		}) as SceneTracks["main"],
		overlay: [
			videoTrack({
				id: "overlay",
				elements: overlayElements,
			}) as SceneTracks["overlay"][number],
		],
		audio: [],
		order: ["overlay", "main"],
	};
}

describe("global timeline gaps", () => {
	test("finds the empty interval bounded by the nearest elements on any layer", () => {
		const tracks = sceneTracks({
			mainElements: [
				element({ id: "main-left", start: 0, duration: 100 }),
				element({ id: "main-right", start: 300, duration: 100 }),
			],
			overlayElements: [
				element({ id: "overlay-left", start: 40, duration: 100 }),
				element({ id: "overlay-right", start: 240, duration: 40 }),
			],
		});

		expect(
			findGlobalTimelineGapAtTime({
				tracks,
				time: time(200),
			}),
		).toEqual({
			startTime: time(140),
			endTime: time(240),
		});
	});

	test("does not offer a gap when another layer covers the clicked time", () => {
		const tracks = sceneTracks({
			mainElements: [
				element({ id: "main-left", start: 0, duration: 100 }),
				element({ id: "main-right", start: 300, duration: 100 }),
			],
			overlayElements: [
				element({ id: "covering-overlay", start: 150, duration: 100 }),
			],
		});

		expect(
			findGlobalTimelineGapAtTime({
				tracks,
				time: time(200),
			}),
		).toBeNull();
	});

	test("supports deleting leading empty time but not meaningless trailing space", () => {
		const tracks = sceneTracks({
			mainElements: [element({ id: "first", start: 100, duration: 50 })],
		});

		expect(
			findGlobalTimelineGapAtTime({
				tracks,
				time: time(40),
			}),
		).toEqual({
			startTime: time(0),
			endTime: time(100),
		});
		expect(
			findGlobalTimelineGapAtTime({
				tracks,
				time: time(200),
			}),
		).toBeNull();
	});

	test("revalidates the exact gap before applying a ripple delete", () => {
		const tracks = sceneTracks({
			mainElements: [
				element({ id: "left", start: 0, duration: 100 }),
				element({ id: "right", start: 200, duration: 100 }),
			],
		});

		expect(
			isExactGlobalTimelineGap({
				tracks,
				startTime: time(100),
				endTime: time(200),
			}),
		).toBe(true);
		expect(
			isExactGlobalTimelineGap({
				tracks,
				startTime: time(110),
				endTime: time(200),
			}),
		).toBe(false);
	});
});
