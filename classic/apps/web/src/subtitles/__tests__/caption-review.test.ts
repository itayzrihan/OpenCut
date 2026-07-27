import { describe, expect, test } from "bun:test";
import {
	buildCaptionReviewWordDeletePatch,
	buildCaptionReviewWordInsertPatch,
	buildCaptionReviewWordPatch,
	collectCaptionReviewItems,
	findClosestCaptionReviewItem,
} from "@/subtitles/caption-review";
import type {
	SceneTracks,
	TextElement,
	TextTrack,
	TextWordRun,
	VideoTrack,
} from "@/timeline";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

function textElement({
	id,
	text,
	start,
	duration,
	wordRuns,
}: {
	id: string;
	text: string;
	start: number;
	duration: number;
	wordRuns?: TextWordRun[];
}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: mediaTimeFromSeconds({ seconds: start }),
		duration: mediaTimeFromSeconds({ seconds: duration }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			content: text,
		},
		wordRuns,
	};
}

function wordRun({
	id,
	text,
	start,
	end,
}: {
	id: string;
	text: string;
	start: number;
	end: number;
}): TextWordRun {
	return {
		id,
		text,
		lineIndex: 0,
		startTime: mediaTimeFromSeconds({ seconds: start }),
		endTime: mediaTimeFromSeconds({ seconds: end }),
	};
}

function textTrack({
	id,
	elements,
	hasCaptionSource = false,
}: {
	id: string;
	elements: TextElement[];
	hasCaptionSource?: boolean;
}): TextTrack {
	return {
		id,
		type: "text",
		name: id,
		hidden: false,
		elements,
		captionSource: hasCaptionSource
			? {
					words: [],
					settings: {
						wordsPerRow: 4,
						rows: 2,
						inPaddingPercent: 0,
						outPaddingPercent: 0,
						revealMode: "emphasize-spoken",
						transitionIn: "blur-zoom",
						wordAnimationId: "kinetic-slam-1",
						accentColor: "#c8ff4d",
						wordDirection: "auto",
						hidePunctuation: false,
						placementMode: "grid",
						placementGridX: 0.5,
						placementGridY: 1,
						manualPositionX: 0,
						manualPositionY: 0,
					},
				}
			: undefined,
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

function tracks(): SceneTracks {
	return {
		overlay: [
			textTrack({
				id: "captions",
				hasCaptionSource: true,
				elements: [
					textElement({ id: "second", text: "Second", start: 2, duration: 1 }),
					textElement({
						id: "first",
						text: "First caption",
						start: 0,
						duration: 2,
					}),
				],
			}),
			textTrack({
				id: "title",
				elements: [
					textElement({ id: "title-1", text: "Title", start: 1, duration: 1 }),
				],
			}),
		],
		main: mainTrack(),
		audio: [],
	};
}

describe("caption review", () => {
	test("collects text words in timeline order", () => {
		const items = collectCaptionReviewItems({ tracks: tracks() });

		expect(items.map((item) => `${item.elementId}:${item.wordIndex}`)).toEqual([
			"first:0",
			"first:1",
			"title-1:0",
			"second:0",
		]);
		expect(items.map((item) => item.text)).toEqual([
			"First",
			"caption",
			"Title",
			"Second",
		]);
		expect(items[0]?.isCaptionSource).toBe(true);
		expect(items[2]?.isCaptionSource).toBe(false);
	});

	test("finds the text word closest to the playhead", () => {
		const items = collectCaptionReviewItems({ tracks: tracks() });

		expect(
			findClosestCaptionReviewItem({
				items,
				time: mediaTimeFromSeconds({ seconds: 1.8 }),
			})?.elementId,
		).toBe("first");
		expect(
			findClosestCaptionReviewItem({
				items,
				time: mediaTimeFromSeconds({ seconds: 1.8 }),
			})?.wordIndex,
		).toBe(1);
		expect(
			findClosestCaptionReviewItem({
				items,
				time: mediaTimeFromSeconds({ seconds: 2.2 }),
			})?.elementId,
		).toBe("second");
	});

	test("builds a patch that edits rendered word runs and text content", () => {
		const element = textElement({
			id: "caption",
			text: "Hello world",
			start: 0,
			duration: 2,
			wordRuns: [
				wordRun({ id: "word-0", text: "Hello", start: 0, end: 1 }),
				wordRun({ id: "word-1", text: "world", start: 1, end: 2 }),
			],
		});

		const patch = buildCaptionReviewWordPatch({
			element,
			wordIndex: 1,
			text: "there",
		});

		expect(patch?.params?.content).toBe("Hello there");
		expect(patch?.wordRuns?.[0]?.text).toBe("Hello");
		expect(patch?.wordRuns?.[1]?.text).toBe("there");
	});

	test("builds a patch that removes one rendered word without retiming neighbors", () => {
		const element = textElement({
			id: "caption",
			text: "Hello quiet world",
			start: 0,
			duration: 3,
			wordRuns: [
				wordRun({ id: "word-0", text: "Hello", start: 0, end: 1 }),
				wordRun({ id: "word-1", text: "quiet", start: 1, end: 2 }),
				wordRun({ id: "word-2", text: "world", start: 2, end: 3 }),
			],
		});

		const patch = buildCaptionReviewWordDeletePatch({
			element,
			wordIndex: 1,
		});

		expect(patch?.params?.content).toBe("Hello world");
		expect(patch?.wordRuns?.map((run) => run.text)).toEqual([
			"Hello",
			"world",
		]);
		expect(patch?.wordRuns?.[0]?.endTime).toBe(
			mediaTimeFromSeconds({ seconds: 1 }),
		);
		expect(patch?.wordRuns?.[1]?.startTime).toBe(
			mediaTimeFromSeconds({ seconds: 2 }),
		);
	});

	test("builds a patch that inserts a rendered word without pushing neighbors", () => {
		const element = textElement({
			id: "caption",
			text: "Hello world",
			start: 0,
			duration: 2,
			wordRuns: [
				wordRun({ id: "word-0", text: "Hello", start: 0, end: 1 }),
				wordRun({ id: "word-1", text: "world", start: 1, end: 2 }),
			],
		});

		const patch = buildCaptionReviewWordInsertPatch({
			element,
			insertIndex: 1,
			text: "wide",
		});

		expect(patch?.params?.content).toBe("Hello wide world");
		expect(patch?.wordRuns?.map((run) => run.text)).toEqual([
			"Hello",
			"wide",
			"world",
		]);
		expect(patch?.wordRuns?.[0]?.endTime).toBe(
			mediaTimeFromSeconds({ seconds: 1 }),
		);
		expect(patch?.wordRuns?.[2]?.startTime).toBe(
			mediaTimeFromSeconds({ seconds: 1 }),
		);
	});
});
