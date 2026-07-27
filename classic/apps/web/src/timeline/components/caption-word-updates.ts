import type { SelectedTextWordRef } from "@/selection/editor-selection";
import type {
	SceneTracks,
	TextElement,
	TextTrack,
	TextWordRun,
} from "@/timeline/types";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
} from "@/wasm/media-time";

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

function contentFromWords({ words }: { words: ContentWord[] }) {
	const rows = new Map<number, string[]>();
	for (const word of words) {
		rows.set(word.lineIndex, [...(rows.get(word.lineIndex) ?? []), word.text]);
	}
	return [...rows.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, rowWords]) => rowWords.filter(Boolean).join(" "))
		.join("\n");
}

function normalizeEditedWordText({ text }: { text: string }) {
	return text.replace(/\s+/g, " ").trim();
}

function uniqueWordRunId({
	wordRuns,
	insertIndex,
}: {
	wordRuns: TextWordRun[];
	insertIndex: number;
}) {
	const usedIds = new Set(wordRuns.map((run) => run.id));
	const baseId = `word-${insertIndex}`;
	if (!usedIds.has(baseId)) return baseId;
	let suffix = 1;
	while (usedIds.has(`${baseId}-${suffix}`)) {
		suffix += 1;
	}
	return `${baseId}-${suffix}`;
}

function wordRunsContentPatch({ wordRuns }: { wordRuns: TextWordRun[] }) {
	return {
		params: {
			content: contentFromWords({
				words: wordRuns.map((run) => ({
					text: run.text,
					lineIndex: run.lineIndex,
				})),
			}),
		},
		wordRuns,
	};
}

function buildTextElementWordTextPatch({
	element,
	wordIndex,
	text,
}: {
	element: TextElement;
	wordIndex: number;
	text: string;
}): Partial<TextElement> | null {
	const nextText = normalizeEditedWordText({ text });
	if (element.wordRuns?.[wordIndex]) {
		const nextWordRuns = element.wordRuns.map((run, index) =>
			index === wordIndex
				? {
						...run,
						text: nextText,
					}
				: run,
		);
		return wordRunsContentPatch({ wordRuns: nextWordRuns });
	}

	const words = contentWordsFromText({ content: getTextContent({ element }) });
	if (!words[wordIndex]) return null;
	return {
		params: {
			content: contentFromWords({
				words: words.map((word, index) =>
					index === wordIndex
						? {
								...word,
								text: nextText,
							}
						: word,
				),
			}),
		},
	};
}

function insertedWordRunTiming({
	wordRuns,
	insertIndex,
}: {
	wordRuns: TextWordRun[];
	insertIndex: number;
}) {
	const previous = wordRuns[insertIndex - 1];
	const next = wordRuns[insertIndex];
	const previousEnd = previous?.endTime ?? previous?.startTime;
	const nextStart = next?.startTime ?? next?.endTime;
	const minDuration = mediaTimeFromSeconds({ seconds: 0.01 });

	if (previousEnd != null && nextStart != null) {
		const start =
			nextStart > previousEnd
				? previousEnd + Math.round((nextStart - previousEnd) / 2)
				: Math.round((previousEnd + nextStart) / 2);
		return {
			startTime: mediaTime({ ticks: start }),
			endTime: mediaTime({ ticks: start + minDuration }),
		};
	}

	if (previousEnd != null) {
		return {
			startTime: previousEnd,
			endTime: mediaTime({ ticks: previousEnd + minDuration }),
		};
	}

	if (nextStart != null) {
		return {
			startTime: nextStart,
			endTime: mediaTime({ ticks: nextStart + minDuration }),
		};
	}

	return {
		startTime: mediaTimeFromSeconds({ seconds: 0 }),
		endTime: minDuration,
	};
}

export function buildTextElementWordInsertPatch({
	element,
	insertIndex,
	text,
}: {
	element: TextElement;
	insertIndex: number;
	text: string;
}): Partial<TextElement> | null {
	const nextText = normalizeEditedWordText({ text });
	if (!nextText) return null;

	const wordRuns = getTextLayerWordRuns({ element });
	const safeInsertIndex = Math.max(0, Math.min(insertIndex, wordRuns.length));
	if (wordRuns.length > 0) {
		const previous = wordRuns[safeInsertIndex - 1];
		const next = wordRuns[safeInsertIndex];
		const timing = insertedWordRunTiming({
			wordRuns,
			insertIndex: safeInsertIndex,
		});
		const inserted: TextWordRun = {
			id: uniqueWordRunId({ wordRuns, insertIndex: safeInsertIndex }),
			text: nextText,
			lineIndex: previous?.lineIndex ?? next?.lineIndex ?? 0,
			...timing,
		};
		return wordRunsContentPatch({
			wordRuns: [
				...wordRuns.slice(0, safeInsertIndex),
				inserted,
				...wordRuns.slice(safeInsertIndex),
			],
		});
	}

	const words = contentWordsFromText({ content: getTextContent({ element }) });
	const fallbackInsertIndex = Math.max(0, Math.min(insertIndex, words.length));
	return {
		params: {
			content: contentFromWords({
				words: [
					...words.slice(0, fallbackInsertIndex),
					{
						text: nextText,
						lineIndex:
							words[fallbackInsertIndex - 1]?.lineIndex ??
							words[fallbackInsertIndex]?.lineIndex ??
							0,
					},
					...words.slice(fallbackInsertIndex),
				],
			}),
		},
	};
}

export function buildTextElementWordDeletePatch({
	element,
	wordIndex,
}: {
	element: TextElement;
	wordIndex: number;
}): Partial<TextElement> | null {
	if (element.wordRuns?.[wordIndex]) {
		return wordRunsContentPatch({
			wordRuns: element.wordRuns.filter((_, index) => index !== wordIndex),
		});
	}

	const words = contentWordsFromText({ content: getTextContent({ element }) });
	if (!words[wordIndex]) return null;
	return {
		params: {
			content: contentFromWords({
				words: words.filter((_, index) => index !== wordIndex),
			}),
		},
	};
}

function getSelectedTextWordKey({
	trackId,
	elementId,
	wordId,
}: SelectedTextWordRef) {
	return `${trackId}:${elementId}:${wordId}`;
}

function getTextLayerWordRuns({
	element,
}: {
	element: TextElement;
}): TextWordRun[] {
	if (element.wordRuns?.length) return element.wordRuns;
	const content = getTextContent({ element });
	const entries = content.split("\n").flatMap((line, lineIndex) =>
		line
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((text) => ({ text, lineIndex })),
	);
	const durationSeconds = mediaTimeToSeconds({ time: element.duration });
	const wordDuration =
		entries.length > 0 ? durationSeconds / entries.length : 0;
	return entries.map((entry, index) => ({
		id: `word-${index}`,
		text: entry.text,
		lineIndex: entry.lineIndex,
		startTime: mediaTimeFromSeconds({ seconds: index * wordDuration }),
		endTime: mediaTimeFromSeconds({
			seconds: (index + 1) * wordDuration,
		}),
	}));
}

function findTextElementWordEntry({
	tracks,
	ref,
}: {
	tracks: SceneTracks;
	ref: SelectedTextWordRef;
}) {
	const track = tracks.overlay.find(
		(candidate): candidate is TextTrack =>
			candidate.type === "text" && candidate.id === ref.trackId,
	);
	const element = track?.elements.find(
		(candidate) => candidate.id === ref.elementId,
	);
	if (!track || !element) return null;
	const wordIndex = getTextLayerWordRuns({ element }).findIndex(
		(run) => run.id === ref.wordId,
	);
	return wordIndex >= 0 ? { track, element, wordIndex } : null;
}

function mergeTextElementPatches({
	left,
	right,
}: {
	left: Partial<TextElement> | null;
	right: Partial<TextElement> | null;
}): Partial<TextElement> | null {
	if (!left) return right;
	if (!right) return left;
	return {
		...left,
		...right,
		params: {
			...(left.params ?? {}),
			...(right.params ?? {}),
		},
		wordRuns: right.wordRuns ?? left.wordRuns,
	};
}

function buildTextElementWordTimingPatch({
	element,
	wordIndex,
	start,
	end,
}: {
	element: TextElement;
	wordIndex: number;
	start: number;
	end: number;
}): Partial<TextElement> | null {
	const wordRuns = getTextLayerWordRuns({ element });
	if (!wordRuns[wordIndex]) return null;
	const safeEnd = Math.max(start + 0.01, end);
	const elementStart = mediaTimeToSeconds({ time: element.startTime });
	const elementEnd =
		elementStart + mediaTimeToSeconds({ time: element.duration });
	const absoluteRuns = wordRuns.map((run, index) => {
		const runStart =
			index === wordIndex
				? start
				: run.startTime == null
					? elementStart
					: elementStart + mediaTimeToSeconds({ time: run.startTime });
		const runEnd =
			index === wordIndex
				? safeEnd
				: run.endTime == null
					? elementEnd
					: elementStart + mediaTimeToSeconds({ time: run.endTime });
		return {
			run,
			start: roundSeconds(runStart),
			end: roundSeconds(Math.max(runStart + 0.01, runEnd)),
		};
	});
	const nextStart = Math.min(...absoluteRuns.map((run) => run.start));
	const nextEnd = Math.max(...absoluteRuns.map((run) => run.end));

	return {
		startTime: mediaTimeFromSeconds({ seconds: nextStart }),
		duration: mediaTimeFromSeconds({
			seconds: Math.max(0.01, nextEnd - nextStart),
		}),
		wordRuns: absoluteRuns.map(({ run, start, end }) => ({
			...run,
			startTime: mediaTimeFromSeconds({ seconds: start - nextStart }),
			endTime: mediaTimeFromSeconds({ seconds: end - nextStart }),
		})),
	};
}

export function buildTextElementWordUpdates({
	tracks,
	refs,
	currentWord,
	nextWord,
}: {
	tracks: SceneTracks;
	refs: SelectedTextWordRef[];
	currentWord: { text: string; start: number; end: number };
	nextWord: { text: string; start: number; end: number };
}): Array<{
	trackId: string;
	elementId: string;
	patch: Partial<TextElement>;
}> {
	const seenRefs = new Set<string>();
	return refs.flatMap((ref) => {
		const refKey = getSelectedTextWordKey(ref);
		if (seenRefs.has(refKey)) return [];
		seenRefs.add(refKey);

		const entry = findTextElementWordEntry({ tracks, ref });
		if (!entry) return [];
		const textPatch =
			nextWord.text !== currentWord.text
				? buildTextElementWordTextPatch({
						element: entry.element,
						wordIndex: entry.wordIndex,
						text: nextWord.text,
					})
				: null;
		const timingPatch =
			nextWord.start !== currentWord.start || nextWord.end !== currentWord.end
				? buildTextElementWordTimingPatch({
						element: entry.element,
						wordIndex: entry.wordIndex,
						start: nextWord.start,
						end: nextWord.end,
					})
				: null;
		const patch = mergeTextElementPatches({
			left: textPatch,
			right: timingPatch,
		});
		if (!patch) return [];
		return [
			{
				trackId: entry.track.id,
				elementId: entry.element.id,
				patch,
			},
		];
	});
}

function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}
