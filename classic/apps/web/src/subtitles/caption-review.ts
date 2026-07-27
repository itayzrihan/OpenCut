import {
	getDisplayTracks,
	type SceneTracks,
	type TextElement,
	type TextTrack,
} from "@/timeline";
import {
	buildTextElementWordDeletePatch,
	buildTextElementWordInsertPatch,
	buildTextElementWordUpdates,
} from "@/timeline/components/caption-word-updates";
import {
	addMediaTime,
	mediaTime,
	type MediaTime,
} from "@/wasm";

export interface CaptionReviewItem {
	trackId: string;
	trackName: string;
	trackIndex: number;
	elementId: string;
	elementIndex: number;
	wordIndex: number;
	text: string;
	startTime: MediaTime;
	duration: MediaTime;
	isCaptionSource: boolean;
}

interface ContentWord {
	text: string;
	lineIndex: number;
}

function getTextContent({ element }: { element: TextElement }) {
	return typeof element.params.content === "string" ? element.params.content : "";
}

function contentWordsFromText({ content }: { content: string }): ContentWord[] {
	return content.split("\n").flatMap((line, lineIndex) => {
		const words = line.match(/\S+/g) ?? [];
		return words.map((text) => ({ text, lineIndex }));
	});
}

function wordTiming({
	element,
	wordIndex,
	wordCount,
	startTime,
	endTime,
}: {
	element: TextElement;
	wordIndex: number;
	wordCount: number;
	startTime?: MediaTime;
	endTime?: MediaTime;
}) {
	const fallbackDuration = wordCount > 0 ? element.duration / wordCount : 0;
	const relativeStartTime =
		startTime ??
		mediaTime({ ticks: Math.round(wordIndex * fallbackDuration) });
	const fallbackEndTime = mediaTime({
		ticks: Math.round((wordIndex + 1) * fallbackDuration),
	});
	const relativeEndTime =
		endTime && endTime > relativeStartTime ? endTime : fallbackEndTime;

	return {
		startTime: addMediaTime({
			a: element.startTime,
			b: relativeStartTime,
		}),
		duration: mediaTime({
			ticks: Math.max(1, Math.round(relativeEndTime - relativeStartTime)),
		}),
	};
}

function collectElementWords({
	track,
	trackIndex,
	element,
	elementIndex,
}: {
	track: TextTrack;
	trackIndex: number;
	element: TextElement;
	elementIndex: number;
}): CaptionReviewItem[] {
	const wordRuns = element.wordRuns;
	if (wordRuns?.length) {
		return wordRuns.flatMap((run, wordIndex) => {
			const timing = wordTiming({
				element,
				wordIndex,
				wordCount: wordRuns.length,
				startTime: run.startTime,
				endTime: run.endTime,
			});
			return [
				{
					trackId: track.id,
					trackName: track.name,
					trackIndex,
					elementId: element.id,
					elementIndex,
					wordIndex,
					text: run.text,
					startTime: timing.startTime,
					duration: timing.duration,
					isCaptionSource: Boolean(track.captionSource),
				},
			];
		});
	}

	const words = contentWordsFromText({ content: getTextContent({ element }) });
	return words.map((word, wordIndex) => {
		const timing = wordTiming({
			element,
			wordIndex,
			wordCount: words.length,
		});
		return {
			trackId: track.id,
			trackName: track.name,
			trackIndex,
			elementId: element.id,
			elementIndex,
			wordIndex,
			text: word.text,
			startTime: timing.startTime,
			duration: timing.duration,
			isCaptionSource: Boolean(track.captionSource),
		};
	});
}

export function collectCaptionReviewItems({
	tracks,
}: {
	tracks: SceneTracks;
}): CaptionReviewItem[] {
	return getDisplayTracks({ tracks })
		.flatMap((track, trackIndex) => {
			if (track.type !== "text") return [];
			const textTrack = track as TextTrack;
			return textTrack.elements.flatMap((element, elementIndex) =>
				collectElementWords({
					track: textTrack,
					trackIndex,
					element,
					elementIndex,
				}),
			);
		})
		.sort(
			(left, right) =>
				left.startTime - right.startTime ||
				left.trackIndex - right.trackIndex ||
				left.elementIndex - right.elementIndex ||
				left.wordIndex - right.wordIndex,
		);
}

export function findCaptionReviewTextElement({
	tracks,
	item,
}: {
	tracks: SceneTracks;
	item: Pick<CaptionReviewItem, "trackId" | "elementId">;
}): TextElement | null {
	const track = getDisplayTracks({ tracks }).find(
		(candidate): candidate is TextTrack =>
			candidate.type === "text" && candidate.id === item.trackId,
	);
	return (
		track?.elements.find((element) => element.id === item.elementId) ?? null
	);
}

export function buildCaptionReviewWordPatch({
	element,
	wordIndex,
	text,
}: {
	element: TextElement;
	wordIndex: number;
	text: string;
}): Partial<TextElement> | null {
	return buildTextElementWordUpdates({
		tracks: {
			overlay: [
				{
					id: "__caption-review-track",
					type: "text",
					name: "Captions",
					hidden: false,
					elements: [element],
				},
			],
			main: {
				id: "__caption-review-main",
				type: "video",
				name: "Main",
				elements: [],
				muted: false,
				hidden: false,
			},
			audio: [],
		},
		refs: [
			{
				trackId: "__caption-review-track",
				elementId: element.id,
				wordId: element.wordRuns?.[wordIndex]?.id ?? `word-${wordIndex}`,
			},
		],
		currentWord: {
			text: element.wordRuns?.[wordIndex]?.text ?? "",
			start: 0,
			end: 1,
		},
		nextWord: {
			text,
			start: 0,
			end: 1,
		},
	})[0]?.patch ?? null;
}

export function buildCaptionReviewWordInsertPatch({
	element,
	insertIndex,
	text,
}: {
	element: TextElement;
	insertIndex: number;
	text: string;
}): Partial<TextElement> | null {
	return buildTextElementWordInsertPatch({ element, insertIndex, text });
}

export function buildCaptionReviewWordDeletePatch({
	element,
	wordIndex,
}: {
	element: TextElement;
	wordIndex: number;
}): Partial<TextElement> | null {
	return buildTextElementWordDeletePatch({ element, wordIndex });
}

function distanceFromItem({
	item,
	time,
}: {
	item: CaptionReviewItem;
	time: MediaTime;
}) {
	const endTime = addMediaTime({ a: item.startTime, b: item.duration });
	if (time < item.startTime) return item.startTime - time;
	if (time > endTime) return time - endTime;
	return 0;
}

export function findClosestCaptionReviewItem({
	items,
	time,
}: {
	items: CaptionReviewItem[];
	time: MediaTime;
}): CaptionReviewItem | null {
	return (
		items.reduce<CaptionReviewItem | null>((closest, item) => {
			if (!closest) return item;
			const itemDistance = distanceFromItem({ item, time });
			const closestDistance = distanceFromItem({ item: closest, time });
			return itemDistance < closestDistance ? item : closest;
		}, null) ?? null
	);
}
