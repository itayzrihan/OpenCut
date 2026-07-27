import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { CaptionLayoutSettings } from "@/subtitles/caption-layout";
import type {
	SceneTracks,
	TextElement,
	TextTrack,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import type {
	ReconcileCaptionWordsOptions,
	TextLayerWordInput,
} from "opencut-wasm";

mock.module("@/commands/timeline/tracks-snapshot", () => ({
	TracksSnapshotCommand: class TracksSnapshotCommand {},
}));

mock.module("opencut-wasm", () => ({
	preserveAudioDuringTimeRemoval: (options: { clips: unknown[] }) => ({
		clips: options.clips,
		timelineDuration: 0,
	}),
	removeCaptionWordTimeRanges: (options: { words: unknown[] }) => options.words,
	normalizeTextLayerWordIds: ({
		wordRuns,
	}: {
		wordRuns: TextLayerWordInput[];
	}) => {
		const usedIds = new Set<string>();
		return wordRuns.map((word, previousWordIndex) => {
			let id = word.id;
			if (!id.trim() || usedIds.has(id)) {
				id = `word-${previousWordIndex}`;
				let suffix = 1;
				while (usedIds.has(id)) {
					id = `word-${previousWordIndex}-${suffix}`;
					suffix += 1;
				}
			}
			usedIds.add(id);
			return { previousWordIndex, id };
		});
	},
	reconcileCaptionWords: ({
		words,
		textLayers,
	}: ReconcileCaptionWordsOptions) => {
		const generatedWords = words.filter(
			(word) => word.source?.type !== "text-layer",
		);
		const ownedWords = textLayers.flatMap((layer) => {
			const runs: TextLayerWordInput[] = layer.wordRuns?.length
				? layer.wordRuns
				: (layer.content ?? "")
						.trim()
						.split(/\s+/)
						.filter(Boolean)
						.map((text, index) => ({ id: `word-${index}`, text }));
			const duration = layer.duration / 120_000;
			const elementStart = layer.startTime / 120_000;
			return runs.flatMap((run, wordIndex) => {
				const fallbackStart = duration * (wordIndex / runs.length);
				const fallbackEnd = duration * ((wordIndex + 1) / runs.length);
				const rawStart =
					run.startTime == null ? fallbackStart : run.startTime / 120_000;
				const rawEnd =
					run.endTime == null ? fallbackEnd : run.endTime / 120_000;
				if (rawEnd <= 0 || rawStart >= duration) return [];
				const start = Math.max(0, Math.min(duration, rawStart));
				const end = Math.max(start, Math.min(duration, rawEnd));
				if (end <= start) return [];
				return [
					{
						text: run.text,
						start: Math.round((elementStart + start) * 1000) / 1000,
						end: Math.round((elementStart + end) * 1000) / 1000,
						source: {
							type: "text-layer",
							trackId: layer.trackId,
							elementId: layer.elementId,
							wordIndex,
							wordId: run.id,
						},
					},
				];
			});
		});
		return [...generatedWords, ...ownedWords].sort(
			(left, right) =>
				left.start - right.start ||
				left.end - right.end ||
				left.text.localeCompare(right.text),
		);
	},
}));

const originalDocument = globalThis.document;
let DEFAULT_CAPTION_LAYOUT: CaptionLayoutSettings;
let syncCaptionSourceWordsFromElements: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["syncCaptionSourceWordsFromElements"];
let syncTextLayerWordsIntoCaptionSource: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["syncTextLayerWordsIntoCaptionSource"];
let removeTextLayerWordsFromCaptionSource: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["removeTextLayerWordsFromCaptionSource"];
let removeCaptionElementWordsFromSource: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["removeCaptionElementWordsFromSource"];
let reconcileTextLayerWordsInCaptionSource: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["reconcileTextLayerWordsInCaptionSource"];
let normalizeTextLayerWordRunIds: Awaited<
	typeof import("@/subtitles/caption-source-sync")
>["normalizeTextLayerWordRunIds"];
let rebuildCaptionTracksWithSource: Awaited<
	typeof import("@/subtitles/caption-tracks")
>["rebuildCaptionTracksWithSource"];

beforeAll(async () => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => ({
				getContext: () => null,
			}),
		},
	});
	({ DEFAULT_CAPTION_LAYOUT } = await import("@/subtitles/caption-layout"));
	({
		syncCaptionSourceWordsFromElements,
		syncTextLayerWordsIntoCaptionSource,
		removeTextLayerWordsFromCaptionSource,
		removeCaptionElementWordsFromSource,
		reconcileTextLayerWordsInCaptionSource,
		normalizeTextLayerWordRunIds,
	} = await import("@/subtitles/caption-source-sync"));
	({ rebuildCaptionTracksWithSource } =
		await import("@/subtitles/caption-tracks"));
});

afterAll(() => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: originalDocument,
	});
});

function textElement({
	id,
	text,
	start,
	end,
	params = {},
	wordRuns,
}: {
	id: string;
	text: string;
	start: number;
	end: number;
	params?: Partial<TextElement["params"]>;
	wordRuns?: TextElement["wordRuns"];
}): TextElement {
	return {
		id,
		type: "text",
		name: text,
		startTime: mediaTimeFromSeconds({ seconds: start }),
		duration: mediaTimeFromSeconds({ seconds: end - start }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			content: text,
			...params,
		},
		wordRuns: wordRuns ?? [
			{
				id: "word-0",
				text,
				lineIndex: 0,
				startTime: ZERO_MEDIA_TIME,
				endTime: mediaTimeFromSeconds({ seconds: end - start }),
			},
		],
	};
}

function textTrack({
	id = "captions",
	elements,
	settings,
	sourceId,
	words = [
		{ text: "Hello", start: 0, end: 1 },
		{ text: "world", start: 1.2, end: 2 },
	],
}: {
	id?: string;
	elements: TextElement[];
	settings: CaptionLayoutSettings;
	sourceId?: string;
	words?: NonNullable<TextTrack["captionSource"]>["words"];
}): TextTrack {
	return {
		id,
		type: "text",
		name: "Captions",
		hidden: false,
		elements,
		captionSource: {
			sourceId,
			words,
			settings,
			layerIndex: 0,
			layerCount: 1,
		},
	};
}

function manualTextTrack({
	id = "manual-text",
	elements,
}: {
	id?: string;
	elements: TextElement[];
}): TextTrack {
	return {
		id,
		type: "text",
		name: "Manual text",
		hidden: false,
		elements,
	};
}

function mainTrack(): VideoTrack {
	return {
		id: "main",
		type: "video",
		name: "Main",
		elements: [],
		muted: false,
		hidden: false,
	};
}

function elementContent({ element }: { element: TextElement }) {
	return typeof element.params.content === "string"
		? element.params.content
		: "";
}

describe("caption word ownership", () => {
	test("repairs duplicate word IDs inside a merged layer", () => {
		const merged = textElement({
			id: "merged",
			text: "First Second",
			start: 0,
			end: 2,
			wordRuns: [
				{ id: "word-0", text: "First", lineIndex: 0 },
				{ id: "word-0", text: "Second", lineIndex: 0 },
			],
		});
		const tracks: SceneTracks = {
			overlay: [manualTextTrack({ elements: [merged] })],
			main: mainTrack(),
			audio: [],
		};

		const result = normalizeTextLayerWordRunIds({ tracks });
		const element = (result.overlay[0] as TextTrack).elements[0];

		expect(element.wordRuns?.map((word) => word.id)).toEqual([
			"word-0",
			"word-1",
		]);
	});

	test("deduplicates repeated element updates and discovers every manual text layer", () => {
		const first = textElement({
			id: "first",
			text: "First",
			start: 2,
			end: 3,
		});
		const second = textElement({
			id: "second",
			text: "Second",
			start: 4,
			end: 5,
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [],
					settings: DEFAULT_CAPTION_LAYOUT,
					words: [{ text: "Generated", start: 0, end: 1 }],
				}),
				manualTextTrack({ elements: [first, second] }),
			],
			main: mainTrack(),
			audio: [],
		};

		const result = syncTextLayerWordsIntoCaptionSource({
			tracks,
			elements: [
				{ trackId: "manual-text", elementId: "first" },
				{ trackId: "manual-text", elementId: "first" },
			],
		});
		const words = (result.overlay[0] as TextTrack).captionSource?.words ?? [];

		expect(words.map((word) => word.text)).toEqual([
			"Generated",
			"First",
			"Second",
		]);
		expect(
			words.filter((word) => word.source?.elementId === "first"),
		).toHaveLength(1);
	});

	test("repairs stale and orphaned manual ownership from the layers that exist", () => {
		const layer = textElement({
			id: "title",
			text: "Current",
			start: 2,
			end: 3,
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [],
					settings: DEFAULT_CAPTION_LAYOUT,
					words: [
						{ text: "Generated", start: 0, end: 1 },
						{
							text: "Stale",
							start: 8,
							end: 9,
							source: {
								type: "text-layer",
								trackId: "deleted-track",
								elementId: "deleted-element",
								wordIndex: 0,
							},
						},
					],
				}),
				manualTextTrack({ id: "new-track", elements: [layer] }),
			],
			main: mainTrack(),
			audio: [],
		};

		const result = reconcileTextLayerWordsInCaptionSource({ tracks });
		const words = (result.overlay[0] as TextTrack).captionSource?.words ?? [];

		expect(words.map((word) => word.text)).toEqual(["Generated", "Current"]);
		expect(words[1]?.source).toMatchObject({
			type: "text-layer",
			trackId: "new-track",
			elementId: "title",
		});
	});

	test("keeps partially timed words and clamps them to the owning layer", () => {
		const layer = textElement({
			id: "partial",
			text: "Clamped Fallback Outside",
			start: 10,
			end: 12,
			wordRuns: [
				{
					id: "clamped",
					text: "Clamped",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: -1 }),
					endTime: mediaTimeFromSeconds({ seconds: 0.5 }),
				},
				{ id: "fallback", text: "Fallback", lineIndex: 0 },
				{
					id: "outside",
					text: "Outside",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 3 }),
					endTime: mediaTimeFromSeconds({ seconds: 4 }),
				},
			],
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [],
					settings: DEFAULT_CAPTION_LAYOUT,
					words: [],
				}),
				manualTextTrack({ elements: [layer] }),
			],
			main: mainTrack(),
			audio: [],
		};

		const result = reconcileTextLayerWordsInCaptionSource({ tracks });
		const words = (result.overlay[0] as TextTrack).captionSource?.words ?? [];

		expect(words.map((word) => word.text)).toEqual(["Clamped", "Fallback"]);
		expect(words[0]).toMatchObject({ start: 10, end: 10.5 });
		expect(words[1]?.start).toBeGreaterThanOrEqual(10);
		expect(words[1]?.end).toBeLessThanOrEqual(12);
	});

	test("removes generated words owned by an explicitly deleted caption element", () => {
		const deleted = textElement({
			id: "deleted-caption",
			text: "Delete",
			start: 0,
			end: 1,
		});
		const kept = textElement({
			id: "kept-caption",
			text: "Keep",
			start: 2,
			end: 3,
		});
		const previousTracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [deleted, kept],
					settings: DEFAULT_CAPTION_LAYOUT,
					words: [
						{ text: "Delete", start: 0, end: 1 },
						{ text: "Keep", start: 2, end: 3 },
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};
		const tracks: SceneTracks = {
			...previousTracks,
			overlay: [
				textTrack({
					elements: [kept],
					settings: DEFAULT_CAPTION_LAYOUT,
					words: [
						{ text: "Delete", start: 0, end: 1 },
						{ text: "Keep", start: 2, end: 3 },
					],
				}),
			],
		};

		const result = removeCaptionElementWordsFromSource({
			tracks,
			previousTracks,
			elements: [{ trackId: "captions", elementId: "deleted-caption" }],
		});

		expect(
			(result.overlay[0] as TextTrack).captionSource?.words.map(
				(word) => word.text,
			),
		).toEqual(["Keep"]);
	});
});

describe("syncCaptionSourceWordsFromElements", () => {
	test("removes a deleted rendered caption word from source words", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 3,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const previousElement = textElement({
			id: "caption",
			text: "one two three",
			start: 0,
			end: 3,
			wordRuns: [
				{
					id: "word-0",
					text: "one",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 0 }),
					endTime: mediaTimeFromSeconds({ seconds: 1 }),
				},
				{
					id: "word-1",
					text: "two",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 1 }),
					endTime: mediaTimeFromSeconds({ seconds: 2 }),
				},
				{
					id: "word-2",
					text: "three",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 2 }),
					endTime: mediaTimeFromSeconds({ seconds: 3 }),
				},
			],
		});
		const nextElement = {
			...previousElement,
			params: { ...previousElement.params, content: "one three" },
			wordRuns: [previousElement.wordRuns![0], previousElement.wordRuns![2]],
		};
		const sourceWords = [
			{ text: "one", start: 0, end: 1 },
			{ text: "two", start: 1, end: 2 },
			{ text: "three", start: 2, end: 3 },
		];
		const previousTracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [previousElement],
					settings,
					words: sourceWords,
				}),
			],
			main: mainTrack(),
			audio: [],
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [nextElement],
					settings,
					words: sourceWords,
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			previousTracks,
			updates: [{ trackId: "captions", elementId: "caption" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["one", "three"],
		);
	});

	test("renders hidden punctuation without mutating source words", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			hidePunctuation: true,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [{ text: "Hello,", start: 0, end: 1 }],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [{ text: "Hello,", start: 0, end: 1 }],
			settings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionTrack = (nextTracks?.overlay ?? []).find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words[0].text).toBe("Hello,");
		expect(captionTrack?.elements[0]).toBeDefined();
		if (!captionTrack?.elements[0]) {
			throw new Error("Expected rebuilt caption element");
		}
		expect(elementContent({ element: captionTrack.elements[0] })).toBe("Hello");
		expect(captionTrack?.elements[0].wordRuns?.[0]?.text).toBe("Hello");
	});

	test("keeps source punctuation when rendered captions hide punctuation", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			hidePunctuation: true,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const hello = textElement({ id: "hello", text: "Hello", start: 0, end: 1 });
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [hello],
					settings,
					words: [{ text: "Hello,", start: 0, end: 1 }],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
			canvasSize: { width: 1920, height: 1080 },
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words[0].text).toBe("Hello,");
	});

	test("relayouts overlapping caption words without preserving stale duplicates", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const hello = textElement({ id: "hello", text: "Hello", start: 0, end: 1 });
		const world = textElement({
			id: "world",
			text: "world",
			start: 1.2,
			end: 2,
		});
		const movedHello = {
			...hello,
			startTime: mediaTimeFromSeconds({ seconds: 0.5 }),
		};
		const tracks: SceneTracks = {
			overlay: [textTrack({ elements: [movedHello, world], settings })],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
			canvasSize: { width: 1920, height: 1080 },
		});
		const captionTracks = nextTracks.overlay.filter(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const captionElements = captionTracks.flatMap((track) => track.elements);

		expect(captionTracks).toHaveLength(2);
		expect(
			captionElements.map((element) => elementContent({ element })).sort(),
		).toEqual(["Hello", "world"]);
		expect(
			captionElements.filter(
				(element) => elementContent({ element }) === "Hello",
			),
		).toHaveLength(1);
		expect(
			captionElements.find((element) => elementContent({ element }) === "Hello")
				?.id,
		).toBe("hello");
		expect(
			captionElements.find((element) => elementContent({ element }) === "world")
				?.id,
		).toBe("world");
		expect(captionTracks[0].captionSource?.words[0]).toMatchObject({
			text: "Hello",
			start: 0.5,
			end: 1.5,
		});
	});

	test("drops stale generated caption copies during canonical transcript relayout", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const staleHello = textElement({
			id: "hello",
			text: "Hello",
			start: 0,
			end: 1.6,
		});
		const world = textElement({
			id: "world",
			text: "world",
			start: 1.2,
			end: 2,
		});
		const tracks: SceneTracks = {
			overlay: [textTrack({ elements: [staleHello, world], settings })],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [
				{ text: "Hello", start: 0, end: 1.6 },
				{ text: "world", start: 1.2, end: 2 },
			],
			settings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionTracks = (nextTracks?.overlay ?? []).filter(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const nonCaptionTextTracks = (nextTracks?.overlay ?? []).filter(
			(track): track is TextTrack =>
				track.type === "text" && !track.captionSource,
		);
		const captionElements = captionTracks.flatMap((track) => track.elements);

		expect(captionTracks).toHaveLength(2);
		expect(nonCaptionTextTracks).toHaveLength(0);
		expect(
			captionElements.map((element) => elementContent({ element })).sort(),
		).toEqual(["Hello", "world"]);
	});

	test("syncs word text edits without retaining old caption copies", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const editedHello = textElement({
			id: "hello",
			text: "Hi",
			start: 0,
			end: 1,
		});
		const world = textElement({
			id: "world",
			text: "world",
			start: 1.2,
			end: 2,
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [editedHello, world],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{ text: "world", start: 1.2, end: 2 },
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
			canvasSize: { width: 1920, height: 1080 },
		});
		const captionElements = nextTracks.overlay
			.filter(
				(track): track is TextTrack =>
					track.type === "text" && !!track.captionSource,
			)
			.flatMap((track) => track.elements);

		expect(
			captionElements.filter(
				(element) => elementContent({ element }) === "Hello",
			),
		).toHaveLength(0);
		expect(
			captionElements.filter((element) => elementContent({ element }) === "Hi"),
		).toHaveLength(1);
		expect(
			captionElements.map((element) => elementContent({ element })).sort(),
		).toEqual(["Hi", "world"]);
	});

	test("preserves caption presentation while syncing word text edits", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const editedHello = {
			...textElement({
				id: "hello",
				text: "Hi",
				start: 0,
				end: 1,
				wordRuns: [
					{
						id: "word-0",
						text: "Hi",
						lineIndex: 0,
						startTime: ZERO_MEDIA_TIME,
						endTime: mediaTimeFromSeconds({ seconds: 1 }),
						revealMode: "letter-by-letter" as const,
						transitionIn: "typewriter" as const,
						wordAnimationId: "bounce",
						accentColor: "#ffcc00",
						wordDirection: "ltr" as const,
					},
				],
			}),
			captionRevealMode: "spoken-word-keep" as const,
			captionTransitionIn: "rise" as const,
			captionWordAnimationId: "pulse",
			captionAccentColor: "#00ffee",
			captionWordDirection: "rtl" as const,
		};
		const world = {
			...textElement({
				id: "world",
				text: "world",
				start: 1.2,
				end: 2,
			}),
			captionRevealMode: "row" as const,
			captionTransitionIn: "slide" as const,
			captionWordAnimationId: "pop",
			captionAccentColor: "#aa00ff",
			captionWordDirection: "auto" as const,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [editedHello, world],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{ text: "world", start: 1.2, end: 2 },
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
			canvasSize: { width: 1920, height: 1080 },
		});
		const captionElements = nextTracks.overlay
			.filter(
				(track): track is TextTrack =>
					track.type === "text" && !!track.captionSource,
			)
			.flatMap((track) => track.elements);
		const syncedHello = captionElements.find(
			(element) => element.id === "hello",
		);
		const syncedWorld = captionElements.find(
			(element) => element.id === "world",
		);

		expect(syncedHello?.captionRevealMode).toBe("spoken-word-keep");
		expect(syncedHello?.captionTransitionIn).toBe("rise");
		expect(syncedHello?.captionWordAnimationId).toBe("pulse");
		expect(syncedHello?.captionAccentColor).toBe("#00ffee");
		expect(syncedHello?.captionWordDirection).toBe("rtl");
		expect(syncedHello?.wordRuns?.[0]?.revealMode).toBe("letter-by-letter");
		expect(syncedHello?.wordRuns?.[0]?.transitionIn).toBe("typewriter");
		expect(syncedHello?.wordRuns?.[0]?.wordAnimationId).toBe("bounce");
		expect(syncedHello?.wordRuns?.[0]?.accentColor).toBe("#ffcc00");
		expect(syncedWorld?.captionRevealMode).toBe("row");
		expect(syncedWorld?.captionTransitionIn).toBe("slide");
		expect(syncedWorld?.captionWordAnimationId).toBe("pop");
		expect(syncedWorld?.captionAccentColor).toBe("#aa00ff");
		expect(syncedWorld?.captionWordDirection).toBe("auto");
	});

	test("ordinary text edits update caption metadata without relayouting visual layers", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const editedHello = textElement({
			id: "hello",
			text: "Hi",
			start: 0,
			end: 1,
		});
		const world = textElement({
			id: "world",
			text: "world",
			start: 1.2,
			end: 2,
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [editedHello, world],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{ text: "world", start: 1.2, end: 2 },
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
		});
		const captionTracks = nextTracks.overlay.filter(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTracks).toHaveLength(1);
		expect(captionTracks[0].elements.map((element) => element.id)).toEqual([
			"hello",
			"world",
		]);
		expect(
			captionTracks[0].captionSource?.words.map((word) => word.text),
		).toEqual(["Hi", "world"]);
	});

	test("explicit caption relayout preserves element animations effects and transitions", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const animations: NonNullable<TextElement["animations"]> = {
			opacity: {
				keys: [
					{
						id: "fade-key",
						time: ZERO_MEDIA_TIME,
						value: 0.4,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		};
		const effects: NonNullable<TextElement["effects"]> = [
			{
				id: "blur-effect",
				type: "blur",
				enabled: true,
				params: { radius: 12 },
			},
		];
		const transitions: NonNullable<TextElement["transitions"]> = {
			in: {
				id: "transition-in",
				presetId: "fade",
				placement: "in",
				duration: mediaTimeFromSeconds({ seconds: 0.25 }),
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		};
		const styledHello = {
			...textElement({
				id: "hello",
				text: "Hello",
				start: 0,
				end: 1,
			}),
			animations,
			effects,
			transitions,
		};
		const tracks: SceneTracks = {
			overlay: [textTrack({ elements: [styledHello], settings })],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [{ text: "Hello", start: 0, end: 1 }],
			settings: {
				...settings,
				placementMode: "manual",
				manualPositionX: 100,
				manualPositionY: -50,
			},
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const element = (nextTracks?.overlay ?? [])
			.filter(
				(track): track is TextTrack =>
					track.type === "text" && !!track.captionSource,
			)
			.flatMap((track) => track.elements)[0];

		expect(element?.animations).toBe(animations);
		expect(element?.effects).toBe(effects);
		expect(element?.transitions).toBe(transitions);
		expect(element?.params["transform.positionX"]).toBe(100);
		expect(element?.params["transform.positionY"]).toBe(-50);
	});

	test("does not relayout captions for scoped word presentation edits", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const hello = textElement({
			id: "hello",
			text: "Hello",
			start: 0,
			end: 1,
			wordRuns: [
				{
					id: "word-0",
					text: "Hello",
					lineIndex: 0,
					startTime: ZERO_MEDIA_TIME,
					endTime: mediaTimeFromSeconds({ seconds: 1 }),
				},
			],
		});
		const styledHello = {
			...hello,
			wordRuns: hello.wordRuns?.map((word) => ({
				...word,
				revealMode: "spoken-word" as const,
				transitionIn: "slide" as const,
			})),
		};
		const previousTracks: SceneTracks = {
			overlay: [textTrack({ elements: [hello], settings })],
			main: mainTrack(),
			audio: [],
		};
		const nextTracksBeforeSync: SceneTracks = {
			...previousTracks,
			overlay: [textTrack({ elements: [styledHello], settings })],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks: nextTracksBeforeSync,
			previousTracks,
			updates: [{ trackId: "captions", elementId: "hello" }],
			canvasSize: { width: 1920, height: 1080 },
		});
		const captionTracks = nextTracks.overlay.filter(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const captionElements = captionTracks.flatMap((track) => track.elements);

		expect(captionTracks).toHaveLength(1);
		expect(captionElements).toHaveLength(1);
		expect(captionTracks[0].captionSource?.words).toEqual(
			previousTracks.overlay[0].type === "text"
				? previousTracks.overlay[0].captionSource?.words
				: [],
		);
		expect(captionElements[0].wordRuns?.[0]?.revealMode).toBe("spoken-word");
	});

	test("keeps generated source words when a multiline merge removes run timing", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const first = textElement({
			id: "first",
			text: "First",
			start: 0,
			end: 1,
		});
		const second = textElement({
			id: "second",
			text: "Second",
			start: 1,
			end: 2,
		});
		const words = [
			{ text: "First", start: 0, end: 1 },
			{ text: "Second", start: 1, end: 2 },
		];
		const previousTracks: SceneTracks = {
			overlay: [textTrack({ elements: [first, second], settings, words })],
			main: mainTrack(),
			audio: [],
		};
		const merged = {
			...first,
			duration: mediaTimeFromSeconds({ seconds: 2 }),
			params: { ...first.params, content: "First\nSecond" },
			wordRuns: [
				{ id: "word-0", text: "First", lineIndex: 0 },
				{ id: "word-1", text: "Second", lineIndex: 1 },
			],
		};
		const tracks: SceneTracks = {
			...previousTracks,
			overlay: [textTrack({ elements: [merged], settings, words })],
		};

		const result = syncCaptionSourceWordsFromElements({
			tracks,
			previousTracks,
			updates: [{ trackId: "captions", elementId: "first" }],
		});

		expect((result.overlay[0] as TextTrack).captionSource?.words).toEqual(
			words,
		);
	});

	test("syncs timing edits in manually split and merged caption layers without restoring the original chunks", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 3,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const sourceWords = [
			{ text: "one", start: 0, end: 1 },
			{ text: "two", start: 1, end: 2 },
			{ text: "three", start: 2, end: 3 },
			{ text: "four", start: 3, end: 4 },
		];
		const singleWord = textElement({
			id: "single",
			text: "one",
			start: 0,
			end: 1,
		});
		const mergedWords = textElement({
			id: "merged",
			text: "two three four",
			start: 1,
			end: 4,
			wordRuns: [
				{
					id: "word-0",
					text: "two",
					lineIndex: 0,
					startTime: ZERO_MEDIA_TIME,
					endTime: mediaTimeFromSeconds({ seconds: 1 }),
				},
				{
					id: "word-1",
					text: "three",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 1 }),
					endTime: mediaTimeFromSeconds({ seconds: 2 }),
				},
				{
					id: "word-2",
					text: "four",
					lineIndex: 0,
					startTime: mediaTimeFromSeconds({ seconds: 2 }),
					endTime: mediaTimeFromSeconds({ seconds: 3 }),
				},
			],
		});
		const previousTracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [singleWord, mergedWords],
					settings,
					words: sourceWords,
				}),
			],
			main: mainTrack(),
			audio: [],
		};
		const editedMergedWords = {
			...mergedWords,
			wordRuns: mergedWords.wordRuns?.map((run) =>
				run.id === "word-0"
					? {
							...run,
							endTime: mediaTimeFromSeconds({ seconds: 1.5 }),
						}
					: run,
			),
		};
		const tracksBeforeSync: SceneTracks = {
			...previousTracks,
			overlay: [
				textTrack({
					elements: [singleWord, editedMergedWords],
					settings,
					words: sourceWords,
				}),
			],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks: tracksBeforeSync,
			previousTracks,
			updates: [{ trackId: "captions", elementId: "merged" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(
			captionTrack?.elements.map((element) => elementContent({ element })),
		).toEqual(["one", "two three four"]);
		expect(captionTrack?.captionSource?.words).toMatchObject([
			{ text: "one", start: 0, end: 1 },
			{ text: "two", start: 1, end: 2.5 },
			{ text: "three", start: 2, end: 3 },
			{ text: "four", start: 3, end: 4 },
		]);
	});

	test("removes a word from a presentation-only multiline caption without restoring original chunks", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 3,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const sourceWords = [
			{ text: "one", start: 0, end: 1 },
			{ text: "two", start: 1, end: 2 },
			{ text: "three", start: 2, end: 3 },
		];
		const mergedWords = textElement({
			id: "merged",
			text: "one\ntwo\nthree",
			start: 0,
			end: 3,
			wordRuns: [
				{ id: "word-0", text: "one", lineIndex: 0 },
				{ id: "word-1", text: "two", lineIndex: 1 },
				{ id: "word-2", text: "three", lineIndex: 2 },
			],
		});
		const previousTracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [mergedWords],
					settings,
					words: sourceWords,
				}),
			],
			main: mainTrack(),
			audio: [],
		};
		const editedMergedWords = {
			...mergedWords,
			params: {
				...mergedWords.params,
				content: "one\nthree",
			},
			wordRuns: [mergedWords.wordRuns![0], mergedWords.wordRuns![2]],
		};
		const tracksBeforeSync: SceneTracks = {
			...previousTracks,
			overlay: [
				textTrack({
					elements: [editedMergedWords],
					settings,
					words: sourceWords,
				}),
			],
		};

		const nextTracks = syncCaptionSourceWordsFromElements({
			tracks: tracksBeforeSync,
			previousTracks,
			updates: [{ trackId: "captions", elementId: "merged" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.elements.map((element) => element.id)).toEqual([
			"merged",
		]);
		expect(
			captionTrack?.elements.map((element) => elementContent({ element })),
		).toEqual(["one\nthree"]);
		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["one", "three"],
		);
	});

	test("rebuild removes stale caption source tracks after a text edit", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					id: "captions-old",
					elements: [
						textElement({ id: "old-hello", text: "Hello", start: 0, end: 1 }),
						textElement({ id: "old-world", text: "world", start: 1.2, end: 2 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{ text: "world", start: 1.2, end: 2 },
					],
				}),
				textTrack({
					id: "captions-new",
					elements: [
						textElement({ id: "new-hi", text: "Hi", start: 0, end: 1 }),
						textElement({ id: "new-world", text: "world", start: 1.2, end: 2 }),
					],
					settings,
					words: [
						{ text: "Hi", start: 0, end: 1 },
						{ text: "world", start: 1.2, end: 2 },
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [
				{ text: "Hi", start: 0, end: 1 },
				{ text: "world", start: 1.2, end: 2 },
			],
			settings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionElements = (nextTracks?.overlay ?? [])
			.filter(
				(track): track is TextTrack =>
					track.type === "text" && !!track.captionSource,
			)
			.flatMap((track) => track.elements);

		expect(
			captionElements.filter(
				(element) => elementContent({ element }) === "Hello",
			),
		).toHaveLength(0);
		expect(
			captionElements.map((element) => elementContent({ element })).sort(),
		).toEqual(["Hi", "world"]);
	});

	test("source ids prevent relayout from touching unrelated caption sets", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					id: "captions-a",
					sourceId: "source-a",
					elements: [
						textElement({ id: "a-hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [{ text: "Hello", start: 0, end: 1 }],
				}),
				textTrack({
					id: "captions-b",
					sourceId: "source-b",
					elements: [
						textElement({ id: "b-hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [{ text: "Hello", start: 0, end: 1 }],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [{ text: "Hi", start: 0, end: 1 }],
			settings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionTracks = (nextTracks?.overlay ?? []).filter(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const trackBySourceId = new Map(
			captionTracks.map((track) => [track.captionSource?.sourceId, track]),
		);

		expect(
			trackBySourceId
				.get("source-a")
				?.elements.map((element) => elementContent({ element })),
		).toEqual(["Hi"]);
		expect(
			trackBySourceId
				.get("source-b")
				?.elements.map((element) => elementContent({ element })),
		).toEqual(["Hello"]);
	});

	test("adds manual text layer words to the source without generating duplicate caption layers", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [{ text: "Hello", start: 0, end: 1 }],
				}),
				manualTextTrack({
					elements: [
						textElement({
							id: "manual-title",
							text: "Manual title",
							start: 2,
							end: 4,
							wordRuns: [],
						}),
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const syncedTracks = syncTextLayerWordsIntoCaptionSource({
			tracks,
			elements: [{ trackId: "manual-text", elementId: "manual-title" }],
		});
		const captionTrack = syncedTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["Hello", "Manual", "title"],
		);
		expect(captionTrack?.captionSource?.words[1].source).toMatchObject({
			type: "text-layer",
			trackId: "manual-text",
			elementId: "manual-title",
			wordIndex: 0,
		});

		const rebuiltTracks = rebuildCaptionTracksWithSource({
			tracks: syncedTracks,
			words: captionTrack?.captionSource?.words ?? [],
			settings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const generatedCaptionElements = (rebuiltTracks?.overlay ?? [])
			.filter(
				(track): track is TextTrack =>
					track.type === "text" && !!track.captionSource,
			)
			.flatMap((track) => track.elements);
		const manualTrack = (rebuiltTracks?.overlay ?? []).find(
			(track): track is TextTrack =>
				track.type === "text" && track.id === "manual-text",
		);

		expect(
			generatedCaptionElements.map((element) => elementContent({ element })),
		).toEqual(["Hello"]);
		expect(manualTrack?.elements.map((element) => element.id)).toEqual([
			"manual-title",
		]);
	});

	test("adds every presentation-only multiline word exactly once", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{
							text: "Manual",
							start: 2,
							end: 4,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
					],
				}),
				manualTextTrack({
					elements: [
						textElement({
							id: "manual-title",
							text: "Manual\ntitle",
							start: 2,
							end: 4,
							wordRuns: [
								{ id: "word-0", text: "Manual", lineIndex: 0 },
								{ id: "word-1", text: "title", lineIndex: 1 },
							],
						}),
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const syncedTracks = syncTextLayerWordsIntoCaptionSource({
			tracks,
			elements: [{ trackId: "manual-text", elementId: "manual-title" }],
		});
		const captionTrack = syncedTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["Hello", "Manual", "title"],
		);
		expect(captionTrack?.captionSource?.words[1].source).toMatchObject({
			type: "text-layer",
			trackId: "manual-text",
			elementId: "manual-title",
			wordIndex: 0,
		});
	});

	test("moving a manual text layer to another track replaces its old source word ref", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{
							text: "Manual",
							start: 2,
							end: 3,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
					],
				}),
				manualTextTrack({ elements: [] }),
				manualTextTrack({
					id: "manual-text-2",
					elements: [
						textElement({
							id: "manual-title",
							text: "Manual",
							start: 2,
							end: 3,
						}),
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncTextLayerWordsIntoCaptionSource({
			tracks,
			elements: [{ trackId: "manual-text-2", elementId: "manual-title" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const manualWords =
			captionTrack?.captionSource?.words.filter(
				(word) => word.source?.type === "text-layer",
			) ?? [];

		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["Hello", "Manual"],
		);
		expect(manualWords).toHaveLength(1);
		expect(manualWords[0].source).toMatchObject({
			type: "text-layer",
			trackId: "manual-text-2",
			elementId: "manual-title",
			wordIndex: 0,
		});
	});

	test("moving a generated caption layer to another track replaces the generated source word", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const captionElement = textElement({
			id: "caption-manual",
			text: "Manual",
			start: 2,
			end: 3,
		});
		const previousTracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [captionElement],
					settings,
					words: [{ text: "Manual", start: 2, end: 3 }],
				}),
				manualTextTrack({ elements: [] }),
			],
			main: mainTrack(),
			audio: [],
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [],
					settings,
					words: [{ text: "Manual", start: 2, end: 3 }],
				}),
				manualTextTrack({
					elements: [captionElement],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncTextLayerWordsIntoCaptionSource({
			tracks,
			previousTracks,
			elements: [{ trackId: "manual-text", elementId: "caption-manual" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words).toHaveLength(1);
		expect(captionTrack?.captionSource?.words[0]).toMatchObject({
			text: "Manual",
			start: 2,
			end: 3,
			source: {
				type: "text-layer",
				trackId: "manual-text",
				elementId: "caption-manual",
				wordIndex: 0,
			},
		});
	});

	test("removes manual text layer words from the source when the layer is removed", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{
							text: "Manual",
							start: 2,
							end: 3,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
					],
				}),
				manualTextTrack({ elements: [] }),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = removeTextLayerWordsFromCaptionSource({
			tracks,
			elements: [{ trackId: "manual-text", elementId: "manual-title" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);

		expect(captionTrack?.captionSource?.words.map((word) => word.text)).toEqual(
			["Hello"],
		);
	});

	test("manual text split refreshes source words without creating caption layers", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{
							text: "Manual",
							start: 2,
							end: 3,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
						{
							text: "title",
							start: 3,
							end: 4,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 1,
								wordId: "word-1",
							},
						},
					],
				}),
				manualTextTrack({
					elements: [
						textElement({
							id: "manual-title",
							text: "Manual",
							start: 2,
							end: 3,
						}),
						textElement({
							id: "manual-title-right",
							text: "title",
							start: 3,
							end: 4,
						}),
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = syncTextLayerWordsIntoCaptionSource({
			tracks,
			elements: [
				{ trackId: "manual-text", elementId: "manual-title" },
				{ trackId: "manual-text", elementId: "manual-title-right" },
			],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const manualWords =
			captionTrack?.captionSource?.words.filter(
				(word) => word.source?.type === "text-layer",
			) ?? [];

		expect(
			nextTracks.overlay.filter((track) => track.type === "text"),
		).toHaveLength(2);
		expect(manualWords.map((word) => word.text)).toEqual(["Manual", "title"]);
		expect(manualWords.map((word) => word.source?.elementId)).toEqual([
			"manual-title",
			"manual-title-right",
		]);
	});

	test("manual text merge removes stale source words from removed layers", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const afterMerge: SceneTracks = {
			overlay: [
				textTrack({
					elements: [
						textElement({ id: "hello", text: "Hello", start: 0, end: 1 }),
					],
					settings,
					words: [
						{ text: "Hello", start: 0, end: 1 },
						{
							text: "Manual",
							start: 2,
							end: 3,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
						{
							text: "title",
							start: 3,
							end: 4,
							source: {
								type: "text-layer",
								trackId: "manual-text",
								elementId: "manual-title-right",
								wordIndex: 0,
								wordId: "word-0",
							},
						},
					],
				}),
				manualTextTrack({
					elements: [
						textElement({
							id: "manual-title",
							text: "Manual title",
							start: 2,
							end: 4,
							wordRuns: [],
						}),
					],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const withoutRemoved = removeTextLayerWordsFromCaptionSource({
			tracks: afterMerge,
			elements: [{ trackId: "manual-text", elementId: "manual-title-right" }],
		});
		const nextTracks = syncTextLayerWordsIntoCaptionSource({
			tracks: withoutRemoved,
			elements: [{ trackId: "manual-text", elementId: "manual-title" }],
		});
		const captionTrack = nextTracks.overlay.find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const manualWords =
			captionTrack?.captionSource?.words.filter(
				(word) => word.source?.type === "text-layer",
			) ?? [];

		expect(manualWords.map((word) => word.text)).toEqual(["Manual", "title"]);
		expect(manualWords.map((word) => word.source?.elementId)).toEqual([
			"manual-title",
			"manual-title",
		]);
		expect(manualWords.map((word) => word.source?.wordIndex)).toEqual([0, 1]);
	});

	test("applies caption placement without resetting edited text presentation", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			placementMode: "grid" as const,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const styledHello = textElement({
			id: "hello",
			text: "Hello",
			start: 0,
			end: 1,
			params: {
				fontFamily: "Impact",
				fontSize: 48,
				color: "#ff00ff",
				"transform.positionX": 12,
				"transform.positionY": 24,
				"transform.scaleX": 1.5,
				"background.enabled": true,
				"background.color": "#111111",
			},
		});
		const tracks: SceneTracks = {
			overlay: [textTrack({ elements: [styledHello], settings })],
			main: mainTrack(),
			audio: [],
		};
		const nextSettings = {
			...settings,
			placementMode: "manual" as const,
			manualPositionX: 320,
			manualPositionY: -180,
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [{ text: "Hello", start: 0, end: 1 }],
			settings: nextSettings,
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionTrack = (nextTracks?.overlay ?? []).find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const element = captionTrack?.elements[0];

		expect(element?.params.fontFamily).toBe("Impact");
		expect(element?.params.fontSize).toBe(48);
		expect(element?.params.color).toBe("#ff00ff");
		expect(element?.params["transform.scaleX"]).toBe(1.5);
		expect(element?.params["background.enabled"]).toBe(true);
		expect(element?.params["background.color"]).toBe("#111111");
		expect(element?.params["transform.positionX"]).toBe(320);
		expect(element?.params["transform.positionY"]).toBe(-180);
	});

	test("hides punctuation without resetting edited text presentation", () => {
		const settings = {
			...DEFAULT_CAPTION_LAYOUT,
			wordsPerRow: 1,
			rows: 1,
			hidePunctuation: false,
			inPaddingPercent: 0,
			outPaddingPercent: 0,
		};
		const styledHello = textElement({
			id: "hello",
			text: "Hello,",
			start: 0,
			end: 1,
			params: {
				fontFamily: "Impact",
				fontSize: 48,
				color: "#ff00ff",
			},
		});
		const tracks: SceneTracks = {
			overlay: [
				textTrack({
					elements: [styledHello],
					settings,
					words: [{ text: "Hello,", start: 0, end: 1 }],
				}),
			],
			main: mainTrack(),
			audio: [],
		};

		const nextTracks = rebuildCaptionTracksWithSource({
			tracks,
			words: [{ text: "Hello,", start: 0, end: 1 }],
			settings: {
				...settings,
				hidePunctuation: true,
			},
			canvasSize: { width: 1920, height: 1080 },
			layerCount: 1,
			preserveEditedElements: false,
		});
		const captionTrack = (nextTracks?.overlay ?? []).find(
			(track): track is TextTrack =>
				track.type === "text" && !!track.captionSource,
		);
		const element = captionTrack?.elements[0];

		expect(elementContent({ element: element! })).toBe("Hello");
		expect(element?.params.fontFamily).toBe("Impact");
		expect(element?.params.fontSize).toBe(48);
		expect(element?.params.color).toBe("#ff00ff");
	});
});
