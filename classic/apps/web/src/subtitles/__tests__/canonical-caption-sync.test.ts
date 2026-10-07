// @opencut-test-wasm: real
import { beforeAll, expect, mock, test } from "bun:test";
import type { SceneTracks, TextElement, TextTrack } from "@/timeline";
import type { CaptionLayoutSettings } from "../caption-layout";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { planCaptionTranscriptSync } from "opencut-wasm";

mock.module("@/commands/timeline/tracks-snapshot", () => ({
	TracksSnapshotCommand: class {},
}));
let actual: typeof import("../caption-source-sync").syncCaptionSourceWordsFromElements;
let legacy: typeof actual;
let actualManual: typeof import("../caption-source-sync").syncTextLayerWordsIntoCaptionSource;
let legacyManual: typeof actualManual;
let settings: CaptionLayoutSettings;
beforeAll(async () => {
	actual = (await import("../caption-source-sync"))
		.syncCaptionSourceWordsFromElements;
	legacy = (await import("./legacy-caption-source-sync-fixture"))
		.syncCaptionSourceWordsFromElements;
	actualManual = (await import("../caption-source-sync"))
		.syncTextLayerWordsIntoCaptionSource;
	legacyManual = (await import("./legacy-caption-source-sync-fixture"))
		.syncTextLayerWordsIntoCaptionSource;
	settings = (await import("../caption-layout")).DEFAULT_CAPTION_LAYOUT;
});
function element({
	texts,
	mode,
}: {
	texts: string[];
	mode: string;
}): TextElement {
	return {
		id: "caption",
		type: "text",
		name: "caption",
		startTime: mediaTimeFromSeconds({
			seconds: mode === "move" ? 3.123456 : 0,
		}),
		duration: mediaTimeFromSeconds({ seconds: 1 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { content: texts.join(" ") },
		wordRuns:
			mode === "content"
				? undefined
				: texts.map((text, index) => ({
						id: `word-${index}`,
						text,
						lineIndex: 0,
						startTime:
							mode === "visual"
								? undefined
								: mediaTimeFromSeconds({ seconds: index * 0.3 }),
						endTime:
							mode === "visual" || (mode === "partial" && index === 1)
								? undefined
								: mediaTimeFromSeconds({ seconds: index * 0.3 + 0.2 }),
					})),
	};
}
function tracks({
	e,
	words,
	hide,
	layer,
}: {
	e: TextElement;
	words: TranscriptionWord[];
	hide: boolean;
	layer: number;
}): SceneTracks {
	const track: TextTrack = {
		id: "captions",
		type: "text",
		name: "Captions",
		hidden: false,
		elements: [e],
		captionSource: {
			sourceId: "source",
			words,
			settings: { ...settings, hidePunctuation: hide, wordsPerRow: 2 },
			layerIndex: layer,
			layerCount: 2,
		},
	};
	return {
		overlay: [track],
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
}
test("generated transcript Rust matches the frozen policy across semantic changes and cue fallbacks", () => {
	const enrichedWord = {
		text: "שלום,",
		start: 0,
		end: 0.2,
		confidence: 0.8,
		excludeFromPunctuationHiding: true,
		speaker: { id: "speaker-a", name: "דובר" },
	};
	const words: TranscriptionWord[] = [
		enrichedWord,
		{ text: "world!", start: 0.3, end: 0.5 },
		{ text: "שלום,", start: 0.6, end: 0.8 },
		{ text: "כן?", start: 0.9, end: 1.1 },
		{
			text: "manual",
			start: 2,
			end: 3,
			source: {
				type: "text-layer",
				trackId: "manual",
				elementId: "manual",
				wordIndex: 0,
			},
		},
	];
	let modes = 0;
	for (const previousMode of ["timed", "visual", "content", "partial"]) {
		for (const nextMode of ["timed", "visual", "content", "partial", "move"]) {
			for (const change of ["same", "edit", "delete", "reorder"]) {
				for (const hide of [true, false]) {
					const original = ["שלום", "world"];
					const texts =
						change === "same"
							? original
							: change === "edit"
								? ["חדש", "world"]
								: change === "delete"
									? ["שלום"]
									: ["world", "שלום"];
					const before = tracks({
						e: element({ texts: original, mode: previousMode }),
						words,
						hide,
						layer: 0,
					});
					const next = tracks({
						e: element({ texts, mode: nextMode }),
						words,
						hide,
						layer: 0,
					});
					const args = {
						tracks: next,
						previousTracks: before,
						updates: [{ trackId: "captions", elementId: "caption" }],
					};
					const expected = legacy(args);
					const result = actual(args);
					expect(result).toEqual(expected);
					if (expected === next) expect(result).toBe(next);
					const beforeTrack = before.overlay[0];
					expect(
						beforeTrack.type === "text" && beforeTrack.captionSource?.words,
					).toBe(words);
					modes++;
				}
			}
		}
	}
	for (const layer of [0, 1, 2, -1]) {
		const next = tracks({
			e: element({ texts: ["one", "two"], mode: "timed" }),
			words,
			hide: true,
			layer,
		});
		const args = {
			tracks: next,
			updates: [{ trackId: "captions", elementId: "caption" }],
		};
		expect(actual(args)).toEqual(legacy(args));
		modes++;
	}
	expect(modes).toBe(164);
});

test("source indices distinguish repeated equal words and retain extension fields", () => {
	const first = {
		text: "same",
		start: 0,
		end: 0.2,
		__captionSyncIndex: "user-field",
		confidence: 0.9,
	};
	const second = { ...first, start: 1, end: 1.2 };
	const input = {
		words: [first, second],
		settings: {},
		previousElement: {
			startTime: 0,
			duration: 144000,
			wordRuns: [
				{ id: "a", text: "same", startTime: 0, endTime: 24000 },
				{ id: "b", text: "same", startTime: 120000, endTime: 144000 },
			],
		},
		element: {
			startTime: 0,
			duration: 144000,
			wordRuns: [{ id: "b", text: "same", startTime: 120000, endTime: 144000 }],
		},
	};
	const result = JSON.parse(
		planCaptionTranscriptSync({ inputJson: JSON.stringify(input) }),
	);
	expect(result).toEqual({
		changed: true,
		words: [{ sourceIndex: 1, text: "same", start: 1, end: 1.2 }],
	});
	expect(input.words).toEqual([first, second]);
});

test("scene sync matches ordered multi-track edits and isolates unrelated sources", () => {
	let modes = 0;
	for (const stable of [true, false]) {
		for (const reverse of [true, false]) {
			for (const previous of [true, false]) {
				for (const repeat of [true, false]) {
					const words: TranscriptionWord[] = [
						Object.assign({ text: "one", start: 0, end: 0.2 }, { confidence: 0.7 }),
						{ text: "two", start: 0.3, end: 0.5 },
					];
					const before = tracks({
						e: element({ texts: ["one", "two"], mode: "timed" }),
						words,
						hide: false,
						layer: 0,
					});
					const first = before.overlay[0];
					if (first.type !== "text" || !first.captionSource)
						throw new Error("fixture source missing");
					first.captionSource.sourceId = stable ? "shared" : undefined;
					const second: TextTrack = {
						...first,
						id: "second",
						elements: first.elements.map((e) => ({ ...e, id: "second-clip" })),
					};
					const foreign: TextTrack = {
						...first,
						id: "foreign",
						captionSource: {
							...first.captionSource,
							sourceId: stable ? "foreign" : undefined,
							words: words.map((w) => ({
								...w,
								start: w.start + 10,
								end: w.end + 10,
							})),
						},
					};
					before.overlay.push(second, foreign);
					const next: SceneTracks = {
						...before,
						overlay: before.overlay.map((track) =>
							track.type !== "text" || track.id === "foreign"
								? track
								: {
										...track,
										elements: track.elements.map((e) => ({
											...e,
											startTime: mediaTimeFromSeconds({
												seconds: track.id === "second" ? 4 : 2,
											}),
										})),
									},
						),
					};
					const updates = [
						{ trackId: "captions", elementId: "caption" },
						{ trackId: "second", elementId: "second-clip" },
					];
					if (reverse) updates.reverse();
					if (repeat) updates.push(updates[0]);
					updates.push(
						{ trackId: "foreign", elementId: "caption" },
						{ trackId: "missing", elementId: "caption" },
					);
					const args = {
						tracks: next,
						previousTracks: previous ? before : undefined,
						updates,
					};
					const expected = legacy(args);
					const result = actual(args);
					expect(result).toEqual(expected);
					expect(result.overlay[2]).toBe(foreign);
					if (expected === next) expect(result).toBe(next);
					expect(first.captionSource.words).toBe(words);
					modes++;
				}
			}
		}
	}
	expect(modes).toBe(16);
});

test("moving generated captions to manual text retains exactly one owner for each word", () => {
	let modes = 0;
	for (const mode of ["timed", "visual", "partial", "content"]) {
		for (const stable of [true, false]) {
			for (const duplicate of [true, false]) {
				for (const moved of [true, false]) {
					const words: TranscriptionWord[] = [
						{ text: "one", start: 0, end: 0.2 },
						{ text: "two", start: 0.3, end: 0.5 },
					];
					const before = tracks({
						e: element({ texts: ["one", "two"], mode }),
						words,
						hide: false,
						layer: 0,
					});
					const generated = before.overlay[0];
					if (generated.type !== "text" || !generated.captionSource)
						throw new Error("fixture source missing");
					generated.captionSource.sourceId = stable ? "shared" : undefined;
					const foreign: TextTrack = {
						...generated,
						id: "foreign",
						captionSource: {
							...generated.captionSource,
							sourceId: stable ? "other" : undefined,
							words: words.map((w) => ({
								...w,
								start: w.start + 10,
								end: w.end + 10,
							})),
						},
					};
					before.overlay.push(foreign);
					const manual: TextTrack = {
						...generated,
						id: "manual",
						captionSource: undefined,
						elements: moved
							? generated.elements.map((e) => ({
									...e,
									startTime: mediaTimeFromSeconds({ seconds: 2 }),
								}))
							: [],
					};
					const next: SceneTracks = {
						...before,
						overlay: [
							{ ...generated, elements: moved ? [] : generated.elements },
							manual,
							foreign,
						],
					};
					const refs = [
						{ trackId: moved ? "manual" : "captions", elementId: "caption" },
					];
					if (duplicate) refs.push(refs[0]);
					refs.push({ trackId: "missing", elementId: "missing" });
					const args = { tracks: next, previousTracks: before, elements: refs };
					const expected = legacyManual(args);
					const result = actualManual(args);
					expect(result).toEqual(expected);
					expect(result.overlay[2]).toBe(foreign);
					expect(generated.captionSource.words).toBe(words);
					if (expected === next) expect(result).toBe(next);
					modes++;
				}
			}
		}
	}
	expect(modes).toBe(32);
});
