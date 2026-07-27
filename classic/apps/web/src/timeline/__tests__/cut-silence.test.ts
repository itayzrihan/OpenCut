import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import type {
	FitTextLayerWordsToSpanOptions,
	PreserveClipsDuringTimeRemovalOptions,
	PreserveClipsDuringTimeRemovalResult,
	ReconcileTextContentWordsOptions,
	TextLayerDurationForWordsOptions,
} from "opencut-wasm";
import type {
	AudioTrack,
	EffectElement,
	EffectTrack,
	GraphicElement,
	GraphicTrack,
	ImageElement,
	SceneTracks,
	TextElement,
	TextTrack,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "../types";
import { mediaTime, mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import { DEFAULT_CAPTION_LAYOUT } from "@/subtitles/caption-layout";

let planTimings: (
	options: PreserveClipsDuringTimeRemovalOptions,
) => PreserveClipsDuringTimeRemovalResult;
let lastPlanOptions: PreserveClipsDuringTimeRemovalOptions | null;
let realignCaptionWords: (options: {
	words: Array<{ text: string; start: number; end: number }>;
	ranges: Array<{ start: number; end: number }>;
}) => Array<{ text: string; start: number; end: number }>;

mock.module("@/commands/timeline/tracks-snapshot", () => ({
	TracksSnapshotCommand: class TracksSnapshotCommand {},
}));

mock.module("@/timeline/cut-silence-wasm", () => ({
	cutSilenceWasm: {
		normalizeTimelineTimeRanges: <
			T extends {
				ranges: Array<{ startTime: number; endTime: number }>;
			},
		>(
			options: T,
		) =>
			options.ranges
				.filter(({ startTime, endTime }) => endTime > startTime)
				.sort((left, right) => right.startTime - left.startTime),
		removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
			options.words,
		realignCaptionWordsAfterTimeRemoval: (options: {
			words: Array<{ text: string; start: number; end: number }>;
			ranges: Array<{ start: number; end: number }>;
		}) => realignCaptionWords(options),
		preserveClipsDuringTimeRemoval: (
			options: PreserveClipsDuringTimeRemovalOptions,
		) => planTimings(options),
	},
}));

mock.module("opencut-wasm", () => ({
	fitTextLayerWordsToSpan: (options: FitTextLayerWordsToSpanOptions) =>
		options.wordRuns.flatMap((word, previousWordIndex) => {
			if (word.startTime == null || word.endTime == null) {
				return [{ previousWordIndex, lineIndex: word.lineIndex }];
			}
			const absoluteStart = options.previousStartTime + word.startTime;
			const absoluteEnd = options.previousStartTime + word.endTime;
			const nextEnd = options.nextStartTime + options.nextDuration;
			if (absoluteEnd <= options.nextStartTime || absoluteStart >= nextEnd) {
				return [];
			}
			return [
				{
					previousWordIndex,
					lineIndex: word.lineIndex,
					startTime:
						Math.max(absoluteStart, options.nextStartTime) -
						options.nextStartTime,
					endTime: Math.min(absoluteEnd, nextEnd) - options.nextStartTime,
				},
			];
		}),
	normalizeTimelineTimeRanges: <
		T extends {
			ranges: Array<{ startTime: number; endTime: number }>;
		},
	>(
		options: T,
	) =>
		options.ranges
			.filter(({ startTime, endTime }) => endTime > startTime)
			.sort((left, right) => right.startTime - left.startTime),
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	realignCaptionWordsAfterTimeRemoval: (options: {
		words: Array<{ text: string; start: number; end: number }>;
		ranges: Array<{ start: number; end: number }>;
	}) => realignCaptionWords(options),
	preserveAudioDuringTimeRemoval: (
		options: PreserveClipsDuringTimeRemovalOptions,
	) => planTimings(options),
	reconcileTextContentWords: (options: ReconcileTextContentWordsOptions) =>
		options.previousWords.map((word, previousWordIndex) => ({
			...word,
			previousWordIndex,
		})),
	textLayerDurationForWords: ({ duration }: TextLayerDurationForWordsOptions) =>
		duration,
}));

let removeSilenceRangesFromTracks: typeof import("../cut-silence").removeSilenceRangesFromTracks;
const originalDocument = globalThis.document;

beforeAll(async () => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => ({
				getContext: () => null,
			}),
		},
	});
	({ removeSilenceRangesFromTracks } = await import("../cut-silence"));
});

afterAll(() => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: originalDocument,
	});
});

beforeEach(() => {
	lastPlanOptions = null;
	planTimings = (options) => ({
		clips: options.clips,
		timelineDuration: mediaTime({ ticks: 90 }),
	});
	realignCaptionWords = ({ words }) => words;
});

function baseElement({
	id,
	startTime = 20,
	duration = 30,
}: {
	id: string;
	startTime?: number;
	duration?: number;
}) {
	return {
		id,
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: {},
	};
}

function timelineWithSound({
	startTime,
	duration,
}: {
	startTime: number;
	duration: number;
}): SceneTracks {
	const sound: UploadAudioElement = {
		...baseElement({ id: "sound", startTime, duration }),
		type: "audio",
		sourceType: "upload",
		mediaId: "sound-asset",
	};
	const video: VideoElement = {
		...baseElement({ id: "video", startTime: 0, duration: 100 }),
		type: "video",
		mediaId: "video-asset",
	};
	const main: VideoTrack = {
		id: "main",
		type: "video",
		name: "main",
		elements: [video],
		muted: false,
		hidden: false,
	};
	const audio: AudioTrack = {
		id: "audio",
		type: "audio",
		name: "audio",
		elements: [sound],
		muted: false,
	};

	return {
		overlay: [],
		main,
		audio: [audio],
	};
}

test("applies the Rust plan without splicing sound media", () => {
	const tracks = timelineWithSound({ startTime: 20, duration: 30 });

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 30 }),
				endTime: mediaTime({ ticks: 40 }),
			},
		],
	});

	expect(result.audio[0].elements).toHaveLength(1);
	expect(result.audio[0].elements[0]).toMatchObject({
		id: "sound",
		startTime: 20,
		duration: 30,
		trimStart: 0,
		trimEnd: 0,
	});
});

test("applies moved and end-trimmed sound timings from Rust", () => {
	const tracks = timelineWithSound({ startTime: 70, duration: 30 });
	planTimings = (options) => ({
		clips: options.clips.map((clip) => ({
			...clip,
			startTime: mediaTime({ ticks: 60 }),
			duration: mediaTime({ ticks: 25 }),
			trimEnd: mediaTime({ ticks: 5 }),
		})),
		timelineDuration: mediaTime({ ticks: 90 }),
	});

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
		],
	});

	expect(result.audio[0].elements[0]).toMatchObject({
		id: "sound",
		startTime: 60,
		duration: 25,
		trimStart: 0,
		trimEnd: 5,
	});
});

test("removes a sound when Rust reports no duration inside the video", () => {
	const tracks = timelineWithSound({ startTime: 100, duration: 10 });
	planTimings = (options) => ({
		clips: options.clips.map((clip) => ({
			...clip,
			duration: mediaTime({ ticks: 0 }),
		})),
		timelineDuration: mediaTime({ ticks: 90 }),
	});

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
		],
	});

	expect(result.audio[0].elements).toEqual([]);
});

test("splices only selected videos and preserves every companion layer type", () => {
	const selectedVideo: VideoElement = {
		...baseElement({ id: "selected-video", startTime: 0, duration: 100 }),
		type: "video",
		mediaId: "selected-asset",
	};
	const unselectedVideo: VideoElement = {
		...baseElement({ id: "unselected-video" }),
		type: "video",
		mediaId: "unselected-asset",
	};
	const image: ImageElement = {
		...baseElement({ id: "image" }),
		type: "image",
		mediaId: "image-asset",
	};
	const text: TextElement = {
		...baseElement({ id: "text" }),
		type: "text",
	};
	const graphic: GraphicElement = {
		...baseElement({ id: "graphic" }),
		type: "graphic",
		definitionId: "graphic-definition",
	};
	const effect: EffectElement = {
		...baseElement({ id: "effect" }),
		type: "effect",
		effectType: "blur",
	};
	const sound: UploadAudioElement = {
		...baseElement({ id: "sound" }),
		type: "audio",
		sourceType: "upload",
		mediaId: "sound-asset",
	};
	const videoTrack: VideoTrack = {
		id: "video-overlay",
		name: "video-overlay",
		type: "video",
		elements: [unselectedVideo, image],
		muted: false,
		hidden: false,
	};
	const textTrack: TextTrack = {
		id: "text-track",
		name: "text-track",
		type: "text",
		elements: [text],
		hidden: false,
		captionSource: {
			words: [{ text: "Caption", start: 20, end: 50 }],
			settings: DEFAULT_CAPTION_LAYOUT,
		},
	};
	const graphicTrack: GraphicTrack = {
		id: "graphic-track",
		name: "graphic-track",
		type: "graphic",
		elements: [graphic],
		hidden: false,
	};
	const effectTrack: EffectTrack = {
		id: "effect-track",
		name: "effect-track",
		type: "effect",
		elements: [effect],
		hidden: false,
	};
	const main: VideoTrack = {
		id: "main",
		name: "main",
		type: "video",
		elements: [selectedVideo],
		muted: false,
		hidden: false,
	};
	const audio: AudioTrack = {
		id: "audio",
		name: "audio",
		type: "audio",
		elements: [sound],
		muted: false,
	};
	const tracks: SceneTracks = {
		overlay: [videoTrack, textTrack, graphicTrack, effectTrack],
		main,
		audio: [audio],
	};
	planTimings = (options) => {
		lastPlanOptions = options;
		return {
			clips: options.clips,
			timelineDuration: mediaTime({ ticks: 90 }),
		};
	};

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["selected-video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 30 }),
				endTime: mediaTime({ ticks: 40 }),
			},
		],
	});

	expect(result.main.elements).toHaveLength(2);
	expect(
		result.overlay.flatMap((track) => track.elements.map(({ id }) => id)),
	).toEqual(["unselected-video", "image", "text", "graphic", "effect"]);
	expect(result.audio[0].elements.map(({ id }) => id)).toEqual(["sound"]);
	const resultTextTrack = result.overlay.find(
		(track): track is TextTrack => track.type === "text",
	);
	expect(resultTextTrack?.captionSource?.words).toEqual([
		{ text: "Caption", start: 20, end: 50 },
	]);
	expect(lastPlanOptions?.clips).toHaveLength(7);
	expect(lastPlanOptions?.clips.map(({ sourceRate }) => sourceRate)).toEqual([
		1,
		undefined,
		undefined,
		undefined,
		undefined,
		1,
		undefined,
	]);
});

test("keeps selected video fragments targeted across multiple silence cuts", () => {
	const tracks = timelineWithSound({ startTime: 0, duration: 10 });

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
			{
				startTime: mediaTime({ ticks: 60 }),
				endTime: mediaTime({ ticks: 70 }),
			},
		],
	});

	expect(
		result.main.elements.map(({ startTime, duration }) => ({
			startTime,
			duration,
		})),
	).toEqual([
		{ startTime: 0, duration: 20 },
		{ startTime: 20, duration: 30 },
		{ startTime: 50, duration: 30 },
	]);
});

test("groups ordinary text clips by track for Rust collision repair", () => {
	const tracks = timelineWithSound({ startTime: 0, duration: 10 });
	const textElement = ({
		id,
		startTime,
	}: {
		id: string;
		startTime: number;
	}): TextElement => ({
		...baseElement({ id, startTime, duration: 20 }),
		type: "text",
		params: { content: id },
	});
	tracks.overlay = [
		{
			id: "text-a",
			name: "Text A",
			type: "text",
			hidden: false,
			elements: [
				textElement({ id: "a-1", startTime: 15 }),
				textElement({ id: "a-2", startTime: 35 }),
			],
		},
		{
			id: "text-b",
			name: "Text B",
			type: "text",
			hidden: false,
			elements: [textElement({ id: "b-1", startTime: 35 })],
		},
	];
	planTimings = (options) => {
		lastPlanOptions = options;
		return {
			clips: options.clips,
			timelineDuration: mediaTime({ ticks: 90 }),
		};
	};

	removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
		],
	});

	expect(
		lastPlanOptions?.clips
			.slice(0, 3)
			.map(({ collisionGroup }) => collisionGroup),
	).toEqual(["text-a", "text-a", "text-b"]);
});

test("fits timed text words when collision repair shortens a layer", () => {
	const tracks = timelineWithSound({ startTime: 0, duration: 10 });
	const first: TextElement = {
		...baseElement({ id: "first", startTime: 15, duration: 20 }),
		type: "text",
		params: { content: "Early Late" },
		wordRuns: [
			{
				id: "early",
				text: "Early",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 0 }),
				endTime: mediaTime({ ticks: 8 }),
			},
			{
				id: "late",
				text: "Late",
				lineIndex: 0,
				startTime: mediaTime({ ticks: 12 }),
				endTime: mediaTime({ ticks: 18 }),
			},
		],
	};
	const second: TextElement = {
		...baseElement({ id: "second", startTime: 35, duration: 10 }),
		type: "text",
		params: { content: "Next" },
	};
	tracks.overlay = [
		{
			id: "text-track",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [first, second],
		},
	];
	planTimings = (options) => ({
		clips: options.clips.map((clip, index) =>
			index === 0 ? { ...clip, duration: mediaTime({ ticks: 10 }) } : clip,
		),
		timelineDuration: mediaTime({ ticks: 90 }),
	});

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTime({ ticks: 20 }),
				endTime: mediaTime({ ticks: 30 }),
			},
		],
	});
	const updatedFirst = result.overlay[0]?.elements[0];

	expect(updatedFirst?.type).toBe("text");
	if (updatedFirst?.type !== "text") {
		throw new Error("Expected shortened text layer");
	}
	expect(updatedFirst.duration).toBe(mediaTime({ ticks: 10 }));
	expect(updatedFirst.params.content).toBe("Early");
	expect(updatedFirst.wordRuns).toEqual([
		{
			id: "early",
			text: "Early",
			lineIndex: 0,
			startTime: mediaTime({ ticks: 0 }),
			endTime: mediaTime({ ticks: 8 }),
		},
	]);
});

test("regenerates multi-layer Whisper captions without cue collisions", () => {
	const secondsElement = ({
		id,
		text,
		start,
		end,
	}: {
		id: string;
		text: string;
		start: number;
		end: number;
	}): TextElement => ({
		id,
		name: text,
		type: "text",
		startTime: mediaTimeFromSeconds({ seconds: start }),
		duration: mediaTimeFromSeconds({ seconds: end - start }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { content: text },
	});
	const words = [
		{ text: "One", start: 0, end: 1.2 },
		{ text: "Two", start: 1, end: 1.8 },
		{ text: "Three", start: 1.9, end: 2.6 },
		{ text: "Four", start: 2.7, end: 3.4 },
		{ text: "Five", start: 3.5, end: 4.2 },
	];
	const settings = {
		...DEFAULT_CAPTION_LAYOUT,
		wordsPerRow: 1,
		rows: 1,
		inPaddingPercent: 0,
		outPaddingPercent: 0,
	};
	const source = {
		sourceId: "whisper-source",
		words,
		settings,
		layerCount: 2,
	};
	const captionTracks: TextTrack[] = [
		{
			id: "captions-a",
			name: "Captions 1",
			type: "text",
			hidden: false,
			elements: [
				secondsElement({ id: "one", text: "One", start: 0, end: 1.2 }),
				secondsElement({
					id: "three",
					text: "Three",
					start: 1.9,
					end: 2.6,
				}),
				secondsElement({
					id: "five",
					text: "Five",
					start: 3.5,
					end: 4.2,
				}),
			],
			captionSource: { ...source, layerIndex: 0 },
		},
		{
			id: "captions-b",
			name: "Captions 2",
			type: "text",
			hidden: false,
			elements: [
				secondsElement({ id: "two", text: "Two", start: 1, end: 1.8 }),
				secondsElement({
					id: "four",
					text: "Four",
					start: 2.7,
					end: 3.4,
				}),
			],
			captionSource: { ...source, layerIndex: 1 },
		},
	];
	const video: VideoElement = {
		...baseElement({ id: "video", startTime: 0, duration: 600_000 }),
		type: "video",
		mediaId: "video-asset",
	};
	const tracks: SceneTracks = {
		overlay: captionTracks,
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [video],
		},
		audio: [],
	};
	realignCaptionWords = ({ words: inputWords, ranges }) => {
		expect(ranges).toEqual([{ start: 0.5, end: 1 }]);
		const alignedTimes = [
			[0, 0.5],
			[0.5, 1.3],
			[1.4, 2.1],
			[2.2, 2.9],
			[3, 3.7],
		];
		return inputWords.map((word, index) => ({
			...word,
			start: alignedTimes[index]?.[0] ?? word.start,
			end: alignedTimes[index]?.[1] ?? word.end,
		}));
	};

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTimeFromSeconds({ seconds: 0.5 }),
				endTime: mediaTimeFromSeconds({ seconds: 1 }),
			},
		],
		captionCanvasSize: { width: 1920, height: 1080 },
	});

	const regenerated = result.overlay.filter(
		(track): track is TextTrack =>
			track.type === "text" && !!track.captionSource,
	);
	expect(regenerated).toHaveLength(2);
	for (const track of regenerated) {
		const ordered = [...track.elements].sort(
			(left, right) => left.startTime - right.startTime,
		);
		expect(
			ordered.slice(1).every((element, index) => {
				const previous = ordered[index];
				return (
					previous !== undefined &&
					previous.startTime + previous.duration <= element.startTime
				);
			}),
		).toBe(true);
	}
	expect(regenerated[0]?.captionSource?.words.slice(0, 2)).toEqual([
		{ text: "One", start: 0, end: 0.5 },
		{ text: "Two", start: 0.5, end: 1.3 },
	]);
	expect(
		regenerated
			.flatMap((track) => track.elements)
			.map((element) => ({
				start: mediaTimeToSeconds({ time: element.startTime }),
				end: mediaTimeToSeconds({
					time: mediaTime({ ticks: element.startTime + element.duration }),
				}),
			})),
	).toContainEqual({ start: 0.5, end: 1.3 });

	const refinedWithoutACut = words.map((word) => ({
		...word,
		start: word.start + 0.05,
		end: word.end + 0.05,
	}));
	realignCaptionWords = ({ words: inputWords, ranges }) => {
		expect(ranges).toEqual([]);
		return inputWords;
	};
	const alignmentOnlyResult = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: [],
		ranges: [],
		captionCanvasSize: { width: 1920, height: 1080 },
		captionWordsOverride: refinedWithoutACut,
	});
	const alignmentOnlyTrack = alignmentOnlyResult.overlay.find(
		(track): track is TextTrack =>
			track.type === "text" && !!track.captionSource,
	);
	expect(alignmentOnlyTrack?.captionSource?.words[0]).toEqual({
		text: "One",
		start: 0.05,
		end: 1.25,
	});
	const tiedTimingResult = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: [],
		ranges: [],
		captionCanvasSize: { width: 1920, height: 1080 },
		captionWordsOverride: [
			{ text: "Zulu", start: 0.2, end: 0.4 },
			{ text: "Alpha", start: 0.2, end: 0.4 },
		],
	});
	const tiedTimingTrack = tiedTimingResult.overlay.find(
		(track): track is TextTrack =>
			track.type === "text" && !!track.captionSource,
	);
	expect(tiedTimingTrack?.captionSource?.words.map(({ text }) => text)).toEqual(
		["Zulu", "Alpha"],
	);
});

test("regenerates every independent caption source and targets overrides", () => {
	const settings = {
		...DEFAULT_CAPTION_LAYOUT,
		wordsPerRow: 1,
		rows: 1,
		inPaddingPercent: 0,
		outPaddingPercent: 0,
	};
	const captionElement = ({
		id,
		text,
		start,
		end,
	}: {
		id: string;
		text: string;
		start: number;
		end: number;
	}): TextElement => ({
		id,
		name: text,
		type: "text",
		startTime: mediaTimeFromSeconds({ seconds: start }),
		duration: mediaTimeFromSeconds({ seconds: end - start }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { content: text },
	});
	const sourceAWord = { text: "SourceA", start: 0.2, end: 0.8 };
	const sourceBWord = { text: "SourceB", start: 1.2, end: 1.6 };
	const sourceATrack: TextTrack = {
		id: "source-a-track",
		name: "Source A",
		type: "text",
		hidden: false,
		elements: [
			captionElement({
				id: "source-a-caption",
				text: sourceAWord.text,
				start: sourceAWord.start,
				end: sourceAWord.end,
			}),
		],
		captionSource: {
			sourceId: "source-a",
			words: [sourceAWord],
			settings,
			layerIndex: 0,
			layerCount: 1,
		},
	};
	const sourceBTrack: TextTrack = {
		id: "source-b-track",
		name: "Source B",
		type: "text",
		hidden: false,
		elements: [
			captionElement({
				id: "source-b-caption",
				text: sourceBWord.text,
				start: sourceBWord.start,
				end: sourceBWord.end,
			}),
		],
		captionSource: {
			sourceId: "source-b",
			words: [sourceBWord],
			settings,
			layerIndex: 0,
			layerCount: 1,
		},
	};
	const video: VideoElement = {
		...baseElement({ id: "video", startTime: 0, duration: 360_000 }),
		type: "video",
		mediaId: "video-asset",
	};
	const tracks: SceneTracks = {
		overlay: [sourceATrack, sourceBTrack],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [video],
		},
		audio: [],
	};
	realignCaptionWords = ({ words, ranges }) => {
		expect(ranges).toEqual([{ start: 0.5, end: 1 }]);
		return words.map((word) =>
			word.text === "SourceA"
				? { ...word, start: 0.2, end: 0.5 }
				: { ...word, start: 0.6, end: 1 },
		);
	};

	const result = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTimeFromSeconds({ seconds: 0.5 }),
				endTime: mediaTimeFromSeconds({ seconds: 1 }),
			},
		],
		captionCanvasSize: { width: 1920, height: 1080 },
		captionWordsOverride: [{ text: "OverrideB", start: 1.1, end: 1.5 }],
		captionWordsOverrideSourceId: "source-b",
	});
	const resultSources = new Map(
		result.overlay.flatMap((track) =>
			track.type === "text" && track.captionSource?.sourceId
				? [[track.captionSource.sourceId, track.captionSource.words] as const]
				: [],
		),
	);

	expect(resultSources.get("source-a")).toEqual([
		{ text: "SourceA", start: 0.2, end: 0.5 },
	]);
	expect(resultSources.get("source-b")).toEqual([
		{ text: "OverrideB", start: 0.6, end: 1 },
	]);

	const ambiguousOverride = removeSilenceRangesFromTracks({
		tracks,
		cutElementIds: ["video"],
		ranges: [
			{
				startTime: mediaTimeFromSeconds({ seconds: 0.5 }),
				endTime: mediaTimeFromSeconds({ seconds: 1 }),
			},
		],
		captionCanvasSize: { width: 1920, height: 1080 },
		captionWordsOverride: [{ text: "Ambiguous", start: 1.1, end: 1.5 }],
	});
	const ambiguousSources = new Map(
		ambiguousOverride.overlay.flatMap((track) =>
			track.type === "text" && track.captionSource?.sourceId
				? [[track.captionSource.sourceId, track.captionSource.words] as const]
				: [],
		),
	);
	expect(ambiguousSources.get("source-a")?.[0]?.text).toBe("SourceA");
	expect(ambiguousSources.get("source-b")?.[0]?.text).toBe("SourceB");
});
