import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TextTrack, VideoTrack } from "@/timeline/types";
import { DEFAULT_CAPTION_LAYOUT } from "@/subtitles/caption-layout";
import { mediaTime } from "@/wasm";

// Real caption-tracks.ts transitively imports opencut-wasm, which can't load its wasm
// binary under bun's test runner (see the identical need in cut-silence.test.ts). These two
// helpers are trivial filters, so a faithful re-implementation is enough to test selectors.ts's
// own logic without dragging in the wasm chain.
mock.module("@/subtitles/caption-tracks", () => ({
	findCaptionSourceTrack: ({ tracks }: { tracks: SceneTracks }) =>
		tracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		) ?? null,
	getGeneratedCaptionWords: ({
		words,
	}: {
		words: Array<{ source?: { type: string } }>;
	}) => words.filter((word) => word.source?.type !== "text-layer"),
}));

const { getTranscriptWordsInRange, hasSceneTranscript } = await import(
	"../selectors"
);

const emptyMain: VideoTrack = {
	id: "main",
	name: "Main",
	type: "video",
	elements: [],
	muted: false,
	hidden: false,
};

function tracksWithCaptionSource({
	words,
}: {
	words: Array<{
		text: string;
		start: number;
		end: number;
		source?: {
			type: "text-layer";
			trackId: string;
			elementId: string;
			wordIndex: number;
		};
	}>;
}): SceneTracks {
	const captionTrack: TextTrack = {
		id: "captions",
		name: "Captions",
		type: "text",
		elements: [],
		hidden: false,
		captionSource: { words, settings: DEFAULT_CAPTION_LAYOUT },
	};
	return { overlay: [captionTrack], main: emptyMain, audio: [] };
}

describe("hasSceneTranscript", () => {
	test("is false when no track has a caption source", () => {
		const tracks: SceneTracks = { overlay: [], main: emptyMain, audio: [] };
		expect(hasSceneTranscript({ tracks })).toBe(false);
	});

	test("is true once any text track has a caption source", () => {
		const tracks = tracksWithCaptionSource({ words: [] });
		expect(hasSceneTranscript({ tracks })).toBe(true);
	});
});

describe("getTranscriptWordsInRange", () => {
	test("returns only words whose midpoint falls in range, sorted", () => {
		const tracks = tracksWithCaptionSource({
			words: [
				{ text: "before", start: -1, end: -0.5 },
				{ text: "second", start: 1.5, end: 2 },
				{ text: "first", start: 0, end: 0.5 },
				{ text: "after", start: 10, end: 10.5 },
			],
		});

		const result = getTranscriptWordsInRange({
			tracks,
			startTime: mediaTime({ ticks: 0 }),
			endTime: mediaTime({ ticks: 3 * 120_000 }),
		});

		expect(result.map((word) => word.text)).toEqual(["first", "second"]);
	});

	test("excludes user-edited text-layer words, keeping only generated transcript words", () => {
		const tracks = tracksWithCaptionSource({
			words: [
				{ text: "generated", start: 0, end: 0.5 },
				{
					text: "edited",
					start: 0.6,
					end: 1,
					source: {
						type: "text-layer",
						trackId: "t1",
						elementId: "e1",
						wordIndex: 0,
					},
				},
			],
		});

		const result = getTranscriptWordsInRange({
			tracks,
			startTime: mediaTime({ ticks: 0 }),
			endTime: mediaTime({ ticks: 2 * 120_000 }),
		});

		expect(result.map((word) => word.text)).toEqual(["generated"]);
	});

	test("returns an empty array when the scene has no transcript", () => {
		const tracks: SceneTracks = { overlay: [], main: emptyMain, audio: [] };
		const result = getTranscriptWordsInRange({
			tracks,
			startTime: mediaTime({ ticks: 0 }),
			endTime: mediaTime({ ticks: 120_000 }),
		});
		expect(result).toEqual([]);
	});
});
