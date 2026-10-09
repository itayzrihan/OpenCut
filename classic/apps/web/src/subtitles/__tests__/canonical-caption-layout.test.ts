// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Compare frozen legacy settings with the serialized Rust policy. */
import { expect, test } from "bun:test";
import * as current from "../caption-layout";
import * as legacy from "./legacy-caption-layout-fixture";
import type { CaptionLayoutSettings } from "../caption-layout";
import type { TranscriptionWord } from "@/transcription/types";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { readFile } from "node:fs/promises";

test("Rust caption policy matches legacy settings, rows, reading windows and overflow layers", () => {
	const cases: unknown[] = [
		undefined,
		{},
		{ wordsPerRow: 1, rows: 1, inPaddingPercent: 100, outPaddingPercent: 100 },
		{ wordsPerRow: 3, rows: 2, rowBreaks: [1, 3, 6, 9] },
		{
			wordsPerRow: 0,
			rows: 99,
			rowBreaks: [9, 3, 3, 0, 2.5, "x"],
			inPaddingPercent: -4,
			outPaddingPercent: 200,
		},
		{
			wordsPerRow: NaN,
			rows: Infinity,
			inPaddingPercent: Infinity,
			manualPositionX: NaN,
		},
		{
			presetId: "old-preset",
			accentColor: " ",
			wordDirection: "rtl",
			placementMode: "manual",
			manualPositionX: 200000,
			manualPositionY: -200000,
			hidePunctuation: false,
		},
		{
			revealMode: "spoken-word",
			transitionIn: "blur-zoom",
			wordAnimationId: "mine",
			bottomFadeOutPercent: 27.5,
			placementGridX: 0.7,
			placementGridY: 0.2,
		},
	];
	const words: TranscriptionWord[] = Array.from({ length: 9 }, (_, index) => ({
		text: [
			"שלום!",
			"עולם?",
			"Hello",
			"again",
			"مرحبا",
			"עכשיו",
			"עוד",
			"משפט",
			"End",
		][index],
		start: index * 0.31,
		end: index * 0.31 + 0.05,
		...(index === 0 ? { excludeFromPunctuationHiding: true } : {}),
	}));
	for (const value of cases) {
		const settings = value as CaptionLayoutSettings;
		expect(
			JSON.parse(
				JSON.stringify(current.normalizeCaptionLayoutSettings({ settings })),
			),
		).toEqual(
			JSON.parse(
				JSON.stringify(legacy.normalizeCaptionLayoutSettings({ settings })),
			),
		);
		const actual = current.buildCaptionChunksFromWords({ words, settings });
		const expected = legacy.buildCaptionChunksFromWords({ words, settings });
		expect(actual).toEqual(expected);
		for (const cue of actual)
			for (const word of cue.words ?? []) expect(words).toContain(word);
		for (const layerCount of [1, 2, 3, 16, 0, -1, 99, NaN])
			expect(
				current.splitCaptionCuesByLayer({ captions: actual, layerCount }),
			).toEqual(
				legacy.splitCaptionCuesByLayer({ captions: expected, layerCount }),
			);
	}
});

test("discovered caption cue registry uses the same policy and preserves source metadata", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const source = classic.document.scenes[0].tracks.overlay[0].captionSource;
		source.settings = {
			wordsPerRow: 1,
			rows: 1,
			inPaddingPercent: 10,
			outPaddingPercent: 20,
		};
		source.words = Array.from({ length: 5 }, (_, i) => ({
			text: `word-${i}`,
			start: i,
			end: i + 0.1,
			confidence: 0.8,
			future: { keep: true },
		}));
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		const before = runtime.invokeSync("app.state.read", {}, null).result.data
			.value;
		const expected = current.buildCaptionChunksFromWords({
			words: source.words,
			settings: source.settings,
		});
		const result = runtime.invokeSync(
			"caption.classic.cues.read",
			{
				projectId: "classic-project",
				sceneId: "main-scene",
				trackId: "titles",
				expectedRevision: before.revision,
			},
			null,
		).result.data;
		expect(result.total).toBe(expected.length);
		expect(
			result.cues.map(
				({
					wordIndices: _indices,
					...cue
				}: { wordIndices: number[] } & (typeof expected)[number]) => cue,
			),
		).toEqual(expected);
		expect(
			runtime.invokeSync("app.state.read", {}, null).result.data.value,
		).toEqual(before);
	} finally {
		runtime.free();
	}
}, 60_000);
