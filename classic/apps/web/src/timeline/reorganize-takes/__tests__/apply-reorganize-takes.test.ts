import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
	SceneTracks,
	TextTrack,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTime, mediaTimeToSeconds, type MediaTime } from "@/wasm";
import { DEFAULT_CAPTION_LAYOUT } from "@/subtitles/caption-layout";
import type { TakePhrase } from "../segment-phrases";

let lastRebuildCall: {
	words: TranscriptionWord[];
} | null = null;

mock.module("@/subtitles/caption-tracks", () => ({
	findCaptionSourceTrack: ({ tracks }: { tracks: SceneTracks }) =>
		tracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		) ?? null,
	rebuildCaptionTracksWithSource: ({
		tracks,
		words,
	}: {
		tracks: SceneTracks;
		words: TranscriptionWord[];
	}) => {
		lastRebuildCall = { words };
		return {
			...tracks,
			overlay: tracks.overlay.map((track) =>
				track.type === "text" && track.captionSource
					? { ...track, captionSource: { ...track.captionSource, words } }
					: track,
			),
		};
	},
}));

const { applyReorganizeTakes } = await import("../apply-reorganize-takes");

const CANVAS_SIZE = { width: 1920, height: 1080 };

function ticksFor(seconds: number): MediaTime {
	return mediaTime({ ticks: Math.round(seconds * 120_000) });
}

function buildElement({
	id,
	durationSeconds,
	trimStartSeconds = 0,
	trimEndSeconds = 0,
}: {
	id: string;
	durationSeconds: number;
	trimStartSeconds?: number;
	trimEndSeconds?: number;
}): VideoElement {
	return {
		id,
		type: "video",
		name: "Clip",
		mediaId: "media-1",
		startTime: ticksFor(0),
		duration: ticksFor(durationSeconds),
		trimStart: ticksFor(trimStartSeconds),
		trimEnd: ticksFor(trimEndSeconds),
		params: {},
	};
}

// Shared by reference with buildTracks()'s captionSource.words — apply-reorganize-takes
// identifies "in scope" words by object identity, so the fixture must reuse the same array.
const scopedWords: TranscriptionWord[] = [
	{ text: "Hello", start: 0, end: 0.4 },
	{ text: "there", start: 0.4, end: 1 },
	{ text: "World", start: 1, end: 1.5 },
	{ text: "now", start: 1.5, end: 2 },
];

function buildTracks({ element }: { element: VideoElement }): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		elements: [element],
		muted: false,
		hidden: false,
	};
	const captionTrack: TextTrack = {
		id: "captions",
		name: "Captions",
		type: "text",
		elements: [],
		hidden: false,
		captionSource: {
			words: scopedWords,
			settings: DEFAULT_CAPTION_LAYOUT,
		},
	};
	return { overlay: [captionTrack], main, audio: [] };
}

const phraseA: TakePhrase = {
	id: "p1",
	text: "Hello there",
	startTime: 0,
	endTime: 1,
	wordIndexRange: [0, 2],
};
const phraseB: TakePhrase = {
	id: "p2",
	text: "World now",
	startTime: 1,
	endTime: 2,
	wordIndexRange: [2, 4],
};

beforeEach(() => {
	lastRebuildCall = null;
});

function mainElements(tracks: SceneTracks): VideoElement[] {
	return tracks.main.elements.filter(
		(element): element is VideoElement => element.type === "video",
	);
}

describe("applyReorganizeTakes", () => {
	test("reorders sub-elements and captions to match the plan", () => {
		const element = buildElement({ id: "clip1", durationSeconds: 2 });
		const tracks = buildTracks({ element });

		const result = applyReorganizeTakes({
			tracks,
			element,
			scopedWords,
			phrases: [phraseA, phraseB],
			plan: { order: ["p2", "p1"], cut: [], takeClusters: [] },
			canvasSize: CANVAS_SIZE,
		});

		expect(result).not.toBeNull();
		const elements = mainElements(result!.tracks);
		expect(elements).toHaveLength(2);

		// p2 ("World now") plays first, back-to-back with no gap.
		expect(mediaTimeToSeconds({ time: elements[0].startTime })).toBeCloseTo(0);
		expect(mediaTimeToSeconds({ time: elements[0].duration })).toBeCloseTo(1);
		expect(mediaTimeToSeconds({ time: elements[0].trimStart })).toBeCloseTo(1);

		expect(mediaTimeToSeconds({ time: elements[1].startTime })).toBeCloseTo(1);
		expect(mediaTimeToSeconds({ time: elements[1].duration })).toBeCloseTo(1);
		expect(mediaTimeToSeconds({ time: elements[1].trimStart })).toBeCloseTo(0);

		expect(result!.phraseStartTimes.get("p2")).toBe(elements[0].startTime);
		expect(result!.phraseStartTimes.get("p1")).toBe(elements[1].startTime);

		const words = lastRebuildCall?.words ?? [];
		expect(words.map((word) => word.text)).toEqual([
			"World",
			"now",
			"Hello",
			"there",
		]);
		expect(words[0].start).toBeCloseTo(0);
		expect(words[2].start).toBeCloseTo(1);
	});

	test("drops cut phrases from both the timeline and the captions", () => {
		const element = buildElement({ id: "clip1", durationSeconds: 2 });
		const tracks = buildTracks({ element });

		const result = applyReorganizeTakes({
			tracks,
			element,
			scopedWords,
			phrases: [phraseA, phraseB],
			plan: { order: ["p1"], cut: ["p2"], takeClusters: [] },
			canvasSize: CANVAS_SIZE,
		});

		expect(result).not.toBeNull();
		const elements = mainElements(result!.tracks);
		expect(elements).toHaveLength(1);
		expect(mediaTimeToSeconds({ time: elements[0].duration })).toBeCloseTo(1);

		const words = lastRebuildCall?.words ?? [];
		expect(words.map((word) => word.text)).toEqual(["Hello", "there"]);
	});

	test("never drops a phrase the plan forgot to place or cut", () => {
		const element = buildElement({ id: "clip1", durationSeconds: 2 });
		const tracks = buildTracks({ element });

		const result = applyReorganizeTakes({
			tracks,
			element,
			scopedWords,
			// p2 is neither ordered nor cut — must still survive, appended.
			plan: { order: ["p1"], cut: [], takeClusters: [] },
			phrases: [phraseA, phraseB],
			canvasSize: CANVAS_SIZE,
		});

		expect(result).not.toBeNull();
		expect(mainElements(result!.tracks)).toHaveLength(2);
		expect(result!.phraseStartTimes.has("p1")).toBe(true);
		expect(result!.phraseStartTimes.has("p2")).toBe(true);
	});

	test("returns null when every phrase is cut", () => {
		const element = buildElement({ id: "clip1", durationSeconds: 2 });
		const tracks = buildTracks({ element });

		const result = applyReorganizeTakes({
			tracks,
			element,
			scopedWords,
			phrases: [phraseA, phraseB],
			plan: { order: [], cut: ["p1", "p2"], takeClusters: [] },
			canvasSize: CANVAS_SIZE,
		});

		expect(result).toBeNull();
	});
});
