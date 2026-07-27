import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TextElement, VideoElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type {
	FitTextLayerWordsToSpanOptions,
	FittedTextLayerWord,
	ReconcileTextContentWordsOptions,
	ReconciledTextContentWord,
	TextLayerDurationForWordsOptions,
} from "opencut-wasm";

let reconcileContent: (
	options: ReconcileTextContentWordsOptions,
) => ReconciledTextContentWord[];
let fitWords: (
	options: FitTextLayerWordsToSpanOptions,
) => FittedTextLayerWord[];

mock.module("opencut-wasm", () => ({
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({ clips: options.clips, timelineDuration: 0 }),
	reconcileTextContentWords: (options: ReconcileTextContentWordsOptions) =>
		reconcileContent(options),
	fitTextLayerWordsToSpan: (options: FitTextLayerWordsToSpanOptions) =>
		fitWords(options),
	textLayerDurationForWords: ({
		duration,
		wordRuns,
	}: TextLayerDurationForWordsOptions) =>
		Math.max(
			duration,
			...wordRuns.map((word) => word.endTime ?? word.startTime ?? 0),
		),
}));

let applyElementUpdate: typeof import("@/timeline/update-pipeline").applyElementUpdate;

beforeAll(async () => {
	({ applyElementUpdate } = await import("@/timeline/update-pipeline"));
});

beforeEach(() => {
	reconcileContent = () => [];
	fitWords = () => [];
});

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(element: VideoElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [element],
		},
		audio: [],
	};
}

function buildTextElement(): TextElement {
	return {
		id: "text-1",
		type: "text",
		name: "Text 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: "Alpha Beta" },
		wordRuns: [
			{
				id: "alpha",
				text: "Alpha",
				lineIndex: 0,
				startTime: ZERO_MEDIA_TIME,
				endTime: mediaTime({ ticks: 4 }),
				style: { color: "#ff0000" },
			},
			{
				id: "beta",
				text: "Beta",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 4 }),
				endTime: mediaTime({ ticks: 10 }),
				style: { color: "#00ff00" },
			},
		],
	};
}

function buildTextTracks(element: TextElement): SceneTracks {
	return {
		overlay: [
			{
				id: "text-track",
				type: "text",
				name: "Text",
				hidden: false,
				elements: [element],
			},
		],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [],
		},
		audio: [],
	};
}

describe("applyElementUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const element = buildVideoElement();
		const tracks = buildTracks(element);

		const updatedElement = applyElementUpdate({
			element,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedElement.duration).toBe(mediaTime({ ticks: 7 }));
		expect(Number.isInteger(updatedElement.duration)).toBe(true);
	});

	test("reconciles content edits with word runs without duplicating text", () => {
		const element = buildTextElement();
		const tracks = buildTextTracks(element);
		reconcileContent = () => [
			{
				id: "alpha",
				text: "Alpha",
				lineIndex: 0,
				previousWordIndex: 0,
				startTime: 0,
				endTime: 4,
			},
			{
				id: "beta",
				text: "Gamma",
				lineIndex: 0,
				previousWordIndex: 1,
				startTime: 4,
				endTime: 7,
			},
			{
				id: "word-2",
				text: "New",
				lineIndex: 0,
				previousWordIndex: undefined,
				startTime: 7,
				endTime: 10,
			},
		];

		const updated = applyElementUpdate({
			element,
			patch: { params: { content: "Alpha Gamma New" } },
			context: { tracks, trackId: "text-track" },
		}) as TextElement;

		expect(updated.params.content).toBe("Alpha Gamma New");
		expect(updated.wordRuns?.map((word) => word.text)).toEqual([
			"Alpha",
			"Gamma",
			"New",
		]);
		expect(new Set(updated.wordRuns?.map((word) => word.id)).size).toBe(3);
		expect(updated.wordRuns?.[1]?.style).toEqual({ color: "#00ff00" });
	});

	test("fits timed words to a trimmed layer and removes invisible text", () => {
		const element = buildTextElement();
		const tracks = buildTextTracks(element);
		fitWords = () => [
			{
				previousWordIndex: 1,
				lineIndex: 0,
				startTime: 0,
				endTime: 5,
			},
		];

		const updated = applyElementUpdate({
			element,
			patch: {
				startTime: mediaTime({ ticks: 5 }),
				duration: mediaTime({ ticks: 5 }),
				trimStart: mediaTime({ ticks: 5 }),
			},
			context: { tracks, trackId: "text-track" },
		}) as TextElement;

		expect(updated.params.content).toBe("Beta");
		expect(updated.wordRuns).toHaveLength(1);
		expect(updated.wordRuns?.[0]).toMatchObject({
			id: "beta",
			text: "Beta",
			startTime: 0,
			endTime: 5,
		});
	});

	test("extends a text layer when an inserted word exceeds its old boundary", () => {
		const element = buildTextElement();
		const tracks = buildTextTracks(element);
		const insertedWordRuns = [
			...(element.wordRuns ?? []),
			{
				id: "inserted",
				text: "Inserted",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 10 }),
				endTime: mediaTime({ ticks: 12 }),
			},
		];

		const updated = applyElementUpdate({
			element,
			patch: {
				params: { content: "Alpha Beta Inserted" },
				wordRuns: insertedWordRuns,
			},
			context: { tracks, trackId: "text-track" },
		}) as TextElement;

		expect(updated.duration).toBe(mediaTime({ ticks: 12 }));
		expect(updated.wordRuns?.[2]?.endTime).toBe(mediaTime({ ticks: 12 }));
	});
});
