// @opencut-test-wasm: real
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { SceneTracks, TextTrack } from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import type { CaptionLayoutSettings } from "../caption-layout";
import type { TranscriptionWord } from "@/transcription/types";

let identity = 0;
let measured = false;
const documentDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"document",
);
mock.module("@/utils/id", () => ({
	generateUUID: () => `generated-${identity++}`,
}));
mock.module("@/commands/timeline/tracks-snapshot", () => ({
	TracksSnapshotCommand: class {},
}));
let actual: typeof import("../caption-tracks").rebuildCaptionTracksWithSource;
let legacy: typeof actual;
let settings: CaptionLayoutSettings;
let build: typeof import("../insert").buildCaptionTextTracks;
let cues: typeof import("../caption-layout").buildSubtitleCuesFromWords;
let actualSync: typeof import("../caption-source-sync").syncCaptionSourceWordsFromElements;
let legacySync: typeof actualSync;
beforeAll(async () => {
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => ({
				width: 0,
				height: 0,
				getContext: () =>
					measured
						? {
								font: "",
								letterSpacing: "0px",
								measureText: (text: string) => ({
									width: Array.from(text).length * 12,
								}),
							}
						: null,
			}),
		},
	});
	actual = (await import("../caption-tracks")).rebuildCaptionTracksWithSource;
	legacy = (await import("./legacy-caption-tracks-fixture"))
		.rebuildCaptionTracksWithSource;
	const layout = await import("../caption-layout");
	settings = { ...layout.DEFAULT_CAPTION_LAYOUT, wordsPerRow: 2 };
	cues = layout.buildSubtitleCuesFromWords;
	build = (await import("../insert")).buildCaptionTextTracks;
	actualSync = (await import("../caption-source-sync"))
		.syncCaptionSourceWordsFromElements;
	legacySync = (await import("./legacy-caption-source-sync-fixture"))
		.syncCaptionSourceWordsFromElements;
});
afterAll(() => {
	if (documentDescriptor)
		Object.defineProperty(globalThis, "document", documentDescriptor);
	else Reflect.deleteProperty(globalThis, "document");
});
function serialized(value: unknown) {
	return JSON.parse(JSON.stringify(value));
}

test("reconstruction matches legacy measured geometry, styles and stable ownership across 192 modes", () => {
	const originalWords: TranscriptionWord[] = [
		{ text: "שלום,", start: 0, end: 0.5 },
		{ text: "world!", start: 0.3, end: 0.7 },
		{ text: "שלום,", start: 0.8, end: 1.2 },
		{ text: "כן?", start: 1.5, end: 1.8 },
	];
	let modes = 0;
	for (const measure of [false, true])
		for (const width of [1920, 160]) {
			measured = measure;
			const canvasSize = { width, height: 1080 };
			identity = 0;
			const base = build({
				captions: cues({ words: originalWords, settings }),
				captionSource: { sourceId: "source", words: originalWords, settings },
				layerCount: 2,
				canvasSize,
			});
			const styled = base.map(
				(track, index): TextTrack => ({
					...track,
					id: `source-${index}`,
					name: `Named ${index}`,
					hidden: index === 1,
					elements: track.elements.map((e, i) => ({
						...e,
						id: `source-${index}-element-${i}`,
						name: `Named clip ${i}`,
						hidden: true,
						effects: [
							{
								id: `effect-${index}-${i}`,
								type: "blur",
								enabled: true,
								params: { radius: 12 },
							},
						],
						animations: {
							opacity: {
								keys: [
									{
										id: `key-${index}-${i}`,
										time: ZERO_MEDIA_TIME,
										value: 0.4,
										segmentToNext: "linear",
										tangentMode: "auto",
									},
								],
							},
						},
						transitions: {
							in: {
								id: `transition-${index}-${i}`,
								presetId: "fade",
								placement: "in",
								duration: mediaTimeFromSeconds({ seconds: 0.25 }),
								createdAt: "2026-10-06T00:00:00.000Z",
							},
						},
						captionRevealMode: "spoken-word-keep",
						captionTransitionIn: "rise",
						captionWordAnimationId: "pulse",
						captionAccentColor: "#ff00cc",
						captionWordDirection: "rtl",
						params: {
							...e.params,
							fontWeight: index === 0 ? "\ufeff700 " : "unsupported",
							"background.enabled": true,
							"background.paddingX": 5,
							"background.offsetY": 3,
						},
						wordRuns: e.wordRuns?.map((run, j) => ({
							...run,
							style: { color: j === 0 ? "#ffcc00" : "#aa00ff" },
							revealMode: "letter-by-letter",
							transitionIn: "typewriter",
							wordAnimationId: "bounce",
							accentColor: "#ffcc00",
							wordDirection: "ltr",
						})),
					})),
				}),
			);
			for (const change of [
				"none",
				"text",
				"timing",
				"delete",
				"empty",
				"manual-edit",
			]) {
				const words =
					change === "empty"
						? []
						: change === "delete"
							? originalWords.slice(1)
							: originalWords.map((w, i) =>
									i === 0 && change === "text"
										? { ...w, text: "חדש!" }
										: i === 0 && change === "timing"
											? { ...w, start: 0.123, end: 0.723 }
											: w,
								);
				const sourceTracks = styled.map((track) => ({
					...track,
					elements: track.elements.map((e, i) =>
						change === "manual-edit" && i === 0
							? { ...e, params: { ...e.params, content: "Manual edit" } }
							: e,
					),
				}));
				const tracks: SceneTracks = {
					overlay: sourceTracks,
					audio: [],
					main: {
						id: "main",
						type: "video",
						name: "Main",
						elements: [],
						muted: false,
						hidden: false,
					},
				};
				const before = serialized(tracks);
				for (const preserveEditedElements of [false, true])
					for (const preferred of [false, true]) {
						const ignoredEditedElements = preferred
							? [
									{
										trackId: sourceTracks[0].id,
										elementId: sourceTracks[0].elements[0]?.id ?? "missing",
									},
								]
							: [];
						const args = {
							tracks,
							words,
							settings,
							canvasSize,
							layerCount: 2,
							preserveEditedElements,
							ignoredEditedElements,
						};
						for (const stableSource of [true, false]) {
							const scopedTracks: SceneTracks = stableSource
								? tracks
								: {
										...tracks,
										overlay: sourceTracks.map((track) => ({
											...track,
											captionSource: track.captionSource
												? { ...track.captionSource, sourceId: undefined }
												: undefined,
										})),
									};
							const scopedArgs = { ...args, tracks: scopedTracks };
							const scopedBefore = serialized(scopedTracks);
							identity = 100;
							const expected = legacy(scopedArgs);
							identity = 100;
							const result = actual(scopedArgs);
							expect(serialized(result)).toEqual(serialized(expected));
							expect(serialized(scopedTracks)).toEqual(scopedBefore);
							expect(serialized(tracks)).toEqual(before);
							modes++;
						}
					}
			}
		}
	expect(modes).toBe(192);
});

test("scene transcript edits feed the measured reconstruction without changing unrelated tracks", () => {
	let modes = 0;
	for (const measure of [false, true]) {
		for (const width of [160, 1920]) {
			for (const change of ["move", "edit", "delete"]) {
				measured = measure;
				identity = 0;
				const canvasSize = { width, height: 1080 };
				const words: TranscriptionWord[] = [
					Object.assign({ text: "שלום", start: 0, end: 0.3 }, { confidence: 0.9 }),
					{ text: "world", start: 0.4, end: 0.8 },
				];
				const overlay = build({
					captions: cues({ words, settings }),
					captionSource: { sourceId: "shared", words, settings },
					layerCount: 2,
					canvasSize,
				});
				const before: SceneTracks = {
					overlay,
					main: {
						id: "main",
						type: "video",
						name: "Main",
						muted: false,
						hidden: false,
						elements: [],
					},
					audio: [],
				};
				const next: SceneTracks = {
					...before,
					overlay: overlay.map((track) => ({
						...track,
						elements: track.elements.map((e) => ({
							...e,
							startTime:
								change === "move"
									? mediaTimeFromSeconds({ seconds: 2 })
									: e.startTime,
							wordRuns:
								change === "edit"
									? e.wordRuns?.map((run, i) =>
											i === 0 ? { ...run, text: "חדש" } : run,
										)
									: change === "delete"
										? e.wordRuns?.slice(1)
										: e.wordRuns,
						})),
					})),
				};
				const args = {
					tracks: next,
					previousTracks: before,
					canvasSize,
					updates: next.overlay.flatMap((track) =>
						track.elements.map((e) => ({ trackId: track.id, elementId: e.id })),
					),
				};
				const original = serialized(before);
				identity = 100;
				const expected = legacySync(args);
				identity = 100;
				const result = actualSync(args);
				expect(serialized(result)).toEqual(serialized(expected));
				expect(result.main).toBe(before.main);
				expect(result.audio).toBe(before.audio);
				expect(serialized(before)).toEqual(original);
				modes++;
			}
		}
	}
	expect(modes).toBe(12);
});
