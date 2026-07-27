import { describe, expect, test } from "bun:test";
import type {
	SceneTracks,
	TextElement,
	TextTrack,
	VideoTrack,
} from "@/timeline/types";
import type { TranscriptionWord } from "@/transcription/types";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	getCaptionWordVisibilityIndex,
	getVisibleCaptionWordIndexes,
} from "@/timeline/components/caption-word-visibility";
import {
	buildTextElementWordDeletePatch,
	buildTextElementWordUpdates,
} from "@/timeline/components/caption-word-updates";
import { getWordElementRefs } from "@/timeline/components/caption-word-element-refs";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm/media-time";

const ZOOM_LEVEL = 1;
const PIXELS_PER_SECOND = BASE_TIMELINE_PIXELS_PER_SECOND * ZOOM_LEVEL;

function transcriptionWord({
	text,
	start,
	end = start + 0.4,
}: {
	text: string;
	start: number;
	end?: number;
}): TranscriptionWord {
	return { text, start, end };
}

function visibleWindow({ start, end }: { start: number; end: number }) {
	return {
		start: start * PIXELS_PER_SECOND,
		end: end * PIXELS_PER_SECOND,
	};
}

function textElement({
	id,
	text,
	start,
	end,
	wordRuns,
}: {
	id: string;
	text: string;
	start: number;
	end: number;
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
		params: { content: text },
		wordRuns,
	};
}

function textTrack({ elements }: { elements: TextElement[] }): TextTrack {
	return {
		id: "captions",
		type: "text",
		name: "Captions",
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

describe("caption word timing visibility", () => {
	test("returns only word indexes in the visible time window", () => {
		const words = Array.from({ length: 1000 }, (_, index) =>
			transcriptionWord({ text: `word-${index}`, start: index }),
		);

		expect(
			getVisibleCaptionWordIndexes({
				words,
				visibleWindow: visibleWindow({ start: 500, end: 505 }),
				zoomLevel: ZOOM_LEVEL,
			}),
		).toEqual([500, 501, 502, 503, 504, 505]);
	});

	test("keeps a long word visible when it starts before the viewport", () => {
		const words = [
			transcriptionWord({ text: "long", start: 0, end: 100 }),
			transcriptionWord({ text: "later", start: 101, end: 102 }),
		];

		expect(
			getVisibleCaptionWordIndexes({
				words,
				visibleWindow: visibleWindow({ start: 50, end: 55 }),
				zoomLevel: ZOOM_LEVEL,
			}),
		).toEqual([0]);
	});

	test("uses an index for sorted transcript words", () => {
		const words = Array.from({ length: 1000 }, (_, index) =>
			transcriptionWord({ text: `word-${index}`, start: index }),
		);

		expect(
			getVisibleCaptionWordIndexes({
				words,
				visibilityIndex: getCaptionWordVisibilityIndex({ words }),
				visibleWindow: visibleWindow({ start: 750, end: 752 }),
				zoomLevel: ZOOM_LEVEL,
			}),
		).toEqual([750, 751, 752]);
	});

	test("keeps the dragged word mounted outside the visible range", () => {
		const words = Array.from({ length: 10 }, (_, index) =>
			transcriptionWord({ text: `word-${index}`, start: index }),
		);

		expect(
			getVisibleCaptionWordIndexes({
				words,
				dragPreview: { wordIndex: 9, start: 20, end: 20.4 },
				visibleWindow: visibleWindow({ start: 4, end: 5 }),
				zoomLevel: ZOOM_LEVEL,
			}),
		).toEqual([4, 5, 9]);
	});

	test("does not drop later visible words when one timing is out of order", () => {
		const words = [
			transcriptionWord({ text: "zero", start: 0 }),
			transcriptionWord({ text: "one", start: 1 }),
			transcriptionWord({ text: "future", start: 100 }),
			transcriptionWord({ text: "two", start: 2 }),
			transcriptionWord({ text: "three", start: 3 }),
			transcriptionWord({ text: "four", start: 4 }),
		];

		expect(
			getVisibleCaptionWordIndexes({
				words,
				visibleWindow: visibleWindow({ start: 2, end: 4 }),
				zoomLevel: ZOOM_LEVEL,
			}),
		).toEqual([3, 4, 5]);
	});
});

describe("caption word timing edits", () => {
	test("builds a visible element patch for generated caption words after manual split and merge", () => {
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
		const tracks: SceneTracks = {
			overlay: [textTrack({ elements: [mergedWords] })],
			main: mainTrack(),
			audio: [],
		};
		const currentWord: TranscriptionWord = { text: "two", start: 1, end: 2 };
		const nextWord: TranscriptionWord = { ...currentWord, end: 2.5 };

		const updates = buildTextElementWordUpdates({
			tracks,
			refs: [
				{
					trackId: "captions",
					elementId: "merged",
					wordId: "word-0",
				},
			],
			currentWord,
			nextWord,
		});

		expect(updates).toHaveLength(1);
		expect(updates[0].trackId).toBe("captions");
		expect(updates[0].elementId).toBe("merged");
		expect(
			mediaTimeToSeconds({
				time: updates[0].patch.wordRuns?.[0]?.endTime ?? ZERO_MEDIA_TIME,
			}),
		).toBe(1.5);
		expect(updates[0].patch.params?.content).toBeUndefined();
	});

	test("maps presentation-only merged caption words so deletes target the combined layer", () => {
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
		const refs = getWordElementRefs({
			words: [
				{ text: "one", start: 0, end: 1 },
				{ text: "two", start: 1, end: 2 },
				{ text: "three", start: 2, end: 3 },
			],
			sourceTracks: [textTrack({ elements: [mergedWords] })],
			includePresentationOnly: true,
		});
		const targetRef = refs.get(1)?.[0];
		const patch = buildTextElementWordDeletePatch({
			element: mergedWords,
			wordIndex:
				mergedWords.wordRuns?.findIndex(
					(run) => run.id === targetRef?.wordId,
				) ?? -1,
		});

		expect(targetRef).toEqual({
			trackId: "captions",
			elementId: "merged",
			wordId: "word-1",
		});
		expect(patch?.params?.content).toBe("one\nthree");
		expect(patch?.wordRuns?.map((run) => run.text)).toEqual(["one", "three"]);
	});
});
