import { beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
	SceneTracks,
	TextTrack,
	TimelineElement,
	TimelineTrack,
} from "../types";
import { mediaTime } from "@/wasm";
import type {
	CaptionWord,
	RemoveCaptionWordTimeRangesOptions,
} from "opencut-wasm";

let transformWords: (
	options: RemoveCaptionWordTimeRangesOptions,
) => CaptionWord[];

mock.module("opencut-wasm", () => ({
	removeCaptionWordTimeRanges: (options: RemoveCaptionWordTimeRangesOptions) =>
		transformWords(options),
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({
		clips: options.clips,
		timelineDuration: 0,
	}),
}));

let removeTimeRangeFromTracks: typeof import("../remove-time-range").removeTimeRangeFromTracks;

beforeAll(async () => {
	({ removeTimeRangeFromTracks } = await import("../remove-time-range"));
});

beforeEach(() => {
	transformWords = (options) => options.words;
});

const element = ({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): TimelineElement => ({
	id,
	type: "text",
	name: id,
	startTime: mediaTime({ ticks: startTime }),
	duration: mediaTime({ ticks: duration }),
	trimStart: mediaTime({ ticks: 0 }),
	trimEnd: mediaTime({ ticks: 0 }),
	params: {},
});
const track = ({
	id,
	elements,
}: {
	id: string;
	elements: TimelineElement[];
}): TimelineTrack =>
	({
		id,
		type: "text",
		name: id,
		elements,
		hidden: false,
	}) as TimelineTrack;

test("removes a range and closes it across every layer", () => {
	const tracks = {
		order: ["text", "main", "audio"],
		overlay: [
			track({
				id: "text",
				elements: [
					element({ id: "inside", startTime: 10, duration: 5 }),
					element({ id: "later", startTime: 30, duration: 5 }),
				],
			}),
		],
		main: {
			...track({
				id: "main",
				elements: [
					element({ id: "left", startTime: 0, duration: 10 }),
					element({ id: "right", startTime: 20, duration: 10 }),
				],
			}),
			type: "main",
		},
		audio: [
			track({
				id: "audio",
				elements: [element({ id: "sound", startTime: 20, duration: 10 })],
			}),
		],
	} as unknown as SceneTracks;
	const result = removeTimeRangeFromTracks({
		tracks,
		startTime: mediaTime({ ticks: 10 }),
		endTime: mediaTime({ ticks: 20 }),
	});
	expect(
		result.overlay[0].elements.map((item) => [item.id, item.startTime]),
	).toEqual([["later", mediaTime({ ticks: 20 })]]);
	expect(result.main.elements[1]?.startTime).toBe(mediaTime({ ticks: 10 }));
	expect(result.audio[0].elements[0]?.startTime).toBe(mediaTime({ ticks: 10 }));
	expect(result.order).toEqual(["text", "main", "audio"]);
});

test("splices an internal range out of video media instead of trimming its tail", () => {
	const video = {
		...element({ id: "video", startTime: 0, duration: 30 }),
		type: "video",
		mediaId: "asset-1",
		trimStart: mediaTime({ ticks: 5 }),
		trimEnd: mediaTime({ ticks: 0 }),
	} as TimelineElement;
	const tracks = {
		overlay: [],
		main: {
			...track({ id: "main", elements: [video] }),
			type: "main",
		},
		audio: [],
	} as unknown as SceneTracks;

	const result = removeTimeRangeFromTracks({
		tracks,
		startTime: mediaTime({ ticks: 10 }),
		endTime: mediaTime({ ticks: 20 }),
	});
	const [left, right] = result.main.elements;

	expect(left).toMatchObject({ id: "video", startTime: 0, duration: 10 });
	expect(right).toMatchObject({ startTime: 10, duration: 10, trimStart: 25 });
	expect(right?.id).not.toBe("video");
});

test("applies the same removed range to caption source words", () => {
	transformWords = (options) => {
		expect(options.ranges).toEqual([
			{ start: 10 / 120_000, end: 20 / 120_000 },
		]);
		return [{ text: "After", start: 20 / 120_000, end: 30 / 120_000 }];
	};
	const captionTrack = {
		...track({ id: "captions", elements: [] }),
		captionSource: {
			words: [
				{ text: "Removed", start: 10 / 120_000, end: 20 / 120_000 },
				{ text: "After", start: 30 / 120_000, end: 40 / 120_000 },
			],
			settings: {},
			layerIndex: 0,
			layerCount: 1,
		},
	};
	const tracks = {
		overlay: [captionTrack],
		main: { ...track({ id: "main", elements: [] }), type: "main" },
		audio: [],
	} as unknown as SceneTracks;

	const result = removeTimeRangeFromTracks({
		tracks,
		startTime: mediaTime({ ticks: 10 }),
		endTime: mediaTime({ ticks: 20 }),
	});

	expect((result.overlay[0] as TextTrack).captionSource?.words).toEqual([
		{ text: "After", start: 20 / 120_000, end: 30 / 120_000 },
	]);
});

test("drops removed timed text runs and rebases retained words", () => {
	const timedElement = {
		...element({ id: "timed", startTime: 0, duration: 30 }),
		params: { content: "Removed Kept" },
		wordRuns: [
			{
				id: "removed",
				text: "Removed",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 10 }),
				endTime: mediaTime({ ticks: 20 }),
			},
			{
				id: "kept",
				text: "Kept",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
		],
	} as TimelineElement;
	transformWords = (options) => {
		const kept = options.words.find((word) => word.source?.wordIndex === 1);
		return kept
			? [
					{
						...kept,
						start: 10 / 120_000,
						end: 20 / 120_000,
					},
				]
			: [];
	};
	const tracks = {
		overlay: [track({ id: "text", elements: [timedElement] })],
		main: { ...track({ id: "main", elements: [] }), type: "main" },
		audio: [],
	} as unknown as SceneTracks;

	const result = removeTimeRangeFromTracks({
		tracks,
		startTime: mediaTime({ ticks: 10 }),
		endTime: mediaTime({ ticks: 20 }),
	});
	const retained = result.overlay[0].elements[0];

	expect(retained).toMatchObject({
		duration: 20,
		params: { content: "Kept" },
		wordRuns: [
			{
				id: "kept",
				text: "Kept",
				startTime: 10,
				endTime: 20,
			},
		],
	});
});
