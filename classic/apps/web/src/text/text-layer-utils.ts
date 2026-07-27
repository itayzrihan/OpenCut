import type {
	TextElement,
	TextRowOverride,
	TextWordRun,
} from "@/timeline";
import {
	type MediaTime,
	mediaTime,
	maxMediaTime,
	minMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

interface TimedWordRun {
	run: TextWordRun;
	startTime: MediaTime;
	endTime: MediaTime;
	lineIndex: number;
}

interface TextPart {
	content: string;
	wordRuns: TextWordRun[];
	textRowOverrides?: TextRowOverride[];
}

export type TextLineBreakAction = "start-line" | "join-previous";

function textContent({ element }: { element: TextElement }) {
	return typeof element.params.content === "string" ? element.params.content : "";
}

function wordsFromContent({ element }: { element: TextElement }): TextWordRun[] {
	const entries = textContent({ element })
		.split("\n")
		.flatMap((line, lineIndex) =>
			line
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map((text) => ({ text, lineIndex })),
		);
	const wordDuration =
		entries.length > 0 ? element.duration / entries.length : 0;

	return entries.map((entry, index) => ({
		id: `word-${index}`,
		text: entry.text,
		lineIndex: entry.lineIndex,
		startTime: mediaTime({ ticks: Math.round(index * wordDuration) }),
		endTime: mediaTime({ ticks: Math.round((index + 1) * wordDuration) }),
	}));
}

function stripWordTiming({ run }: { run: TextWordRun }): TextWordRun {
	const next = { ...run };
	delete next.startTime;
	delete next.endTime;
	return next;
}

function timedWordRuns({ element }: { element: TextElement }): TimedWordRun[] {
	const runs = element.wordRuns?.length
		? element.wordRuns
		: wordsFromContent({ element });
	const fallbackWordDuration = runs.length > 0 ? element.duration / runs.length : 0;

	return runs.flatMap((run, index): TimedWordRun[] => {
		const fallbackStart = mediaTime({
			ticks: Math.round(index * fallbackWordDuration),
		});
		const fallbackEnd = mediaTime({
			ticks: Math.round((index + 1) * fallbackWordDuration),
		});
		const startTime = run.startTime ?? fallbackStart;
		const endTime =
			run.endTime && run.endTime > startTime ? run.endTime : fallbackEnd;
		if (!run.text.trim()) return [];
		return [
			{
				run,
				startTime,
				endTime,
				lineIndex: run.lineIndex ?? 0,
			},
		];
	});
}

function normalizeLineIndexes({
	entries,
}: {
	entries: TimedWordRun[];
}): Map<number, number> {
	const originalLineIndexes = [
		...new Set(entries.map((entry) => entry.lineIndex)),
	].sort((left, right) => left - right);
	return new Map(
		originalLineIndexes.map((lineIndex, index) => [lineIndex, index] as const),
	);
}

function contentFromRuns({ runs }: { runs: TextWordRun[] }) {
	const rows = new Map<number, string[]>();
	for (const run of runs) {
		rows.set(run.lineIndex, [...(rows.get(run.lineIndex) ?? []), run.text]);
	}
	return [...rows.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, words]) => words.join(" "))
		.join("\n");
}

function getLineStartIndexes({ runs }: { runs: TextWordRun[] }): number[] {
	return runs.reduce((starts, run, index) => {
		if (index === 0 || run.lineIndex !== runs[index - 1]?.lineIndex) {
			return [...starts, index];
		}
		return starts;
	}, [] as number[]);
}

function applyLineStartIndexes({
	runs,
	lineStartIndexes,
}: {
	runs: TextWordRun[];
	lineStartIndexes: number[];
}): TextWordRun[] {
	const starts = [...new Set([0, ...lineStartIndexes])]
		.filter((index) => index >= 0 && index < runs.length)
		.sort((left, right) => left - right);

	return runs.map((run, index) => ({
		...run,
		lineIndex: starts.filter((start) => start <= index).length - 1,
	}));
}

export function buildTextLineBreakPatch({
	element,
	wordId,
	action,
}: {
	element: TextElement;
	wordId: string;
	action: TextLineBreakAction;
}): Pick<TextElement, "params" | "wordRuns"> | null {
	const hasExplicitWordRuns = (element.wordRuns?.length ?? 0) > 0;
	const runs = hasExplicitWordRuns
		? element.wordRuns ?? []
		: wordsFromContent({ element }).map((run) => stripWordTiming({ run }));
	const wordIndex = runs.findIndex((run) => run.id === wordId);
	if (wordIndex <= 0) return null;

	const starts = new Set(getLineStartIndexes({ runs }));
	if (action === "start-line") {
		starts.add(wordIndex);
	} else {
		starts.delete(wordIndex);
	}

	const wordRuns = applyLineStartIndexes({
		runs,
		lineStartIndexes: [...starts],
	});

	return {
		params: {
			...element.params,
			content: contentFromRuns({ runs: wordRuns }),
		},
		wordRuns,
	};
}

function remapRowOverrides({
	overrides,
	lineIndexMap,
}: {
	overrides: TextRowOverride[] | undefined;
	lineIndexMap: Map<number, number>;
}): TextRowOverride[] | undefined {
	const next = (overrides ?? []).flatMap((override): TextRowOverride[] => {
		const nextLineIndex = lineIndexMap.get(override.lineIndex);
		if (nextLineIndex === undefined) return [];
		return [
			{
				...override,
				id: `row-${nextLineIndex}`,
				lineIndex: nextLineIndex,
			},
		];
	});
	return next.length > 0 ? next : undefined;
}

function buildPart({
	element,
	entries,
	offsetTime,
	duration,
	forceSingleLine,
}: {
	element: TextElement;
	entries: TimedWordRun[];
	offsetTime: MediaTime;
	duration: MediaTime;
	forceSingleLine?: boolean;
}): TextPart {
	const lineIndexMap = normalizeLineIndexes({ entries });
	const wordRuns = entries.map((entry, index) => {
		const startTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: subMediaTime({ a: entry.startTime, b: offsetTime }),
		});
		const endTime = minMediaTime({
			a: duration,
			b: maxMediaTime({
				a: startTime,
				b: subMediaTime({ a: entry.endTime, b: offsetTime }),
			}),
		});
		return {
			...entry.run,
			id: `word-${index}`,
			lineIndex: forceSingleLine ? 0 : (lineIndexMap.get(entry.lineIndex) ?? 0),
			startTime,
			endTime,
		};
	});

	return {
		content: contentFromRuns({ runs: wordRuns }),
		wordRuns,
		textRowOverrides: forceSingleLine
			? remapRowOverrides({
					overrides: element.textRowOverrides,
					lineIndexMap: new Map([[0, 0]]),
				})
			: remapRowOverrides({
					overrides: element.textRowOverrides,
					lineIndexMap,
				}),
	};
}

function applyPartToElement({
	element,
	part,
}: {
	element: TextElement;
	part: TextPart;
}): TextElement {
	return {
		...element,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			...element.params,
			content: part.content,
		},
		wordRuns: part.wordRuns,
		textRowOverrides: part.textRowOverrides,
	};
}

function normalizeMergedTransitions({
	element,
	duration,
}: {
	element: TextElement;
	duration: MediaTime;
}): TextElement["transitions"] {
	if (!element.transitions) return undefined;

	const transitions: TextElement["transitions"] = { ...element.transitions };
	if (transitions.in) {
		const inDuration = minMediaTime({
			a: transitions.in.duration,
			b: duration,
		});
		transitions.in = {
			...transitions.in,
			duration: inDuration,
			startTime: ZERO_MEDIA_TIME,
		};
	}
	if (transitions.out) {
		const outDuration = minMediaTime({
			a: transitions.out.duration,
			b: duration,
		});
		transitions.out = {
			...transitions.out,
			duration: outDuration,
			startTime: mediaTime({
				ticks: Math.max(0, Math.round(duration - outDuration)),
			}),
		};
	}

	return transitions.in || transitions.out ? transitions : undefined;
}

export function splitTextElementAtTime({
	element,
	relativeTime,
	splitTime,
	rightElementId,
}: {
	element: TextElement;
	relativeTime: MediaTime;
	splitTime: MediaTime;
	rightElementId: string;
}): { left: TextElement; right: TextElement } | null {
	if (relativeTime <= ZERO_MEDIA_TIME || relativeTime >= element.duration) {
		return null;
	}

	const entries = timedWordRuns({ element });
	if (entries.length < 2) return null;

	const leftEntries: TimedWordRun[] = [];
	const rightEntries: TimedWordRun[] = [];
	for (const entry of entries) {
		const midpoint = (entry.startTime + entry.endTime) / 2;
		if (midpoint <= relativeTime) {
			leftEntries.push(entry);
		} else {
			rightEntries.push(entry);
		}
	}

	if (leftEntries.length === 0 || rightEntries.length === 0) return null;

	const rightDuration = subMediaTime({
		a: element.duration,
		b: relativeTime,
	});
	const leftPart = buildPart({
		element,
		entries: leftEntries,
		offsetTime: ZERO_MEDIA_TIME,
		duration: relativeTime,
	});
	const rightPart = buildPart({
		element,
		entries: rightEntries,
		offsetTime: relativeTime,
		duration: rightDuration,
	});

	return {
		left: {
			...applyPartToElement({ element, part: leftPart }),
			duration: relativeTime,
		},
		right: {
			...applyPartToElement({ element, part: rightPart }),
			id: rightElementId,
			startTime: splitTime,
			duration: rightDuration,
		},
	};
}

export function mergeTextElements({
	items,
	mode = "single-line",
}: {
	items: Array<{ trackId: string; element: TextElement }>;
	mode?: "single-line" | "multiline";
}): {
	targetTrackId: string;
	targetElementId: string;
	mergedElement: TextElement;
	removeElements: Array<{ trackId: string; elementId: string }>;
} | null {
	if (items.length < 2) return null;

	const sorted = [...items].sort(
		(left, right) =>
			left.element.startTime - right.element.startTime ||
			left.element.id.localeCompare(right.element.id),
	);
	const target = sorted[0];
	const startTime = mediaTime({
		ticks: Math.min(...sorted.map((item) => item.element.startTime)),
	});
	const endTime = mediaTime({
		ticks: Math.max(
			...sorted.map((item) => item.element.startTime + item.element.duration),
		),
	});
	const duration = mediaTime({
		ticks: Math.max(1, Math.round(endTime - startTime)),
	});
	const mergedEntries = sorted.flatMap((item, itemIndex) =>
		timedWordRuns({ element: item.element }).map((entry) => ({
			...entry,
			lineIndex: mode === "multiline" ? itemIndex : entry.lineIndex,
			startTime: mediaTime({
				ticks: Math.round(item.element.startTime - startTime + entry.startTime),
			}),
			endTime: mediaTime({
				ticks: Math.round(item.element.startTime - startTime + entry.endTime),
			}),
		})),
	);
	const part = buildPart({
		element: target.element,
		entries: mergedEntries,
		offsetTime: ZERO_MEDIA_TIME,
		duration,
		forceSingleLine: mode === "single-line",
	});
	const mergedPart =
		mode === "multiline"
			? {
					...part,
					wordRuns: part.wordRuns.map((run) => stripWordTiming({ run })),
				}
			: part;
	const mergedElement = {
		...applyPartToElement({ element: target.element, part: mergedPart }),
		startTime,
		duration,
		name: target.element.name,
		transitions: normalizeMergedTransitions({
			element: target.element,
			duration,
		}),
		...(mode === "multiline"
			? {
					captionWordAnimationId: "none",
					captionRevealMode: "row" as const,
					captionTransitionIn: "none" as const,
				}
			: {}),
	};

	return {
		targetTrackId: target.trackId,
		targetElementId: target.element.id,
		mergedElement,
		removeElements: sorted
			.slice(1)
			.map(({ trackId, element }) => ({ trackId, elementId: element.id })),
	};
}
