import type { TextElement } from "@/timeline";
import { addMediaTime, mediaTime, subMediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { buildTransitionAnimationsFromElement } from "./apply";

export interface TextTransitionArrangeEntry {
	trackId: string;
	element: TextElement;
}

export interface TextTransitionArrangeUpdate {
	trackId: string;
	elementId: string;
	patch: Partial<TextElement>;
}

/**
 * Returns the text layers that participate in at least one real overlap.
 * Touching edges are intentionally not considered an overlap.
 */
export function getOverlappingTextTransitionEntries(
	entries: TextTransitionArrangeEntry[],
): TextTransitionArrangeEntry[] {
	const sorted = sortEntries(entries);
	const overlappingIds = new Set<string>();

	for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
		const left = sorted[leftIndex];
		if (!left) continue;
		const leftEnd = addMediaTime({
			a: left.element.startTime,
			b: left.element.duration,
		});

		for (
			let rightIndex = leftIndex + 1;
			rightIndex < sorted.length;
			rightIndex += 1
		) {
			const right = sorted[rightIndex];
			if (!right) continue;
			if (right.element.startTime >= leftEnd) break;

			const rightEnd = addMediaTime({
				a: right.element.startTime,
				b: right.element.duration,
			});
			if (left.element.startTime < rightEnd) {
				overlappingIds.add(entryKey(left));
				overlappingIds.add(entryKey(right));
			}
		}
	}

	return sorted.filter((entry) => overlappingIds.has(entryKey(entry)));
}

/**
 * Makes adjacent overlapping text layers hand off at the same instant.
 * The transition durations stay unchanged; only the clip boundaries move.
 */
export function arrangeOverlappingTextTransitions({
	entries,
}: {
	entries: TextTransitionArrangeEntry[];
}): TextTransitionArrangeUpdate[] {
	const working = sortEntries(entries).map((entry) => ({
		...entry,
		element: { ...entry.element },
	}));
	const updates = new Map<string, TextTransitionArrangeUpdate>();

	for (let index = 0; index < working.length - 1; index += 1) {
		const previous = working[index];
		const next = working[index + 1];
		if (!previous || !next) continue;

		const previousEnd = addMediaTime({
			a: previous.element.startTime,
			b: previous.element.duration,
		});
		if (next.element.startTime >= previousEnd) continue;

		const outTransition = previous.element.transitions?.out;
		const inTransition = next.element.transitions?.in;
		if (!outTransition || !inTransition) continue;

		const outStart = addMediaTime({
			a: previous.element.startTime,
			b:
				outTransition.startTime ??
				mediaTime({
					ticks: Math.max(
						0,
						previous.element.duration - outTransition.duration,
					),
				}),
		});
		const inStart = addMediaTime({
			a: next.element.startTime,
			b: inTransition.startTime ?? ZERO_MEDIA_TIME,
		});

		// If the next layer already starts at or after the outgoing fade,
		// there is no early entrance to fix.
		const earlyEntrance = outStart - inStart;
		if (earlyEntrance <= 1) continue;

		// Split the correction between the tail of the old layer and the head
		// of the new layer. This preserves both transition durations.
		const trimAmount = mediaTime({ ticks: Math.floor(earlyEntrance / 2) });
		if (
			trimAmount <= ZERO_MEDIA_TIME ||
			trimAmount >= previous.element.duration ||
			trimAmount >= next.element.duration
		) {
			continue;
		}

		const nextPreviousDuration = subMediaTime({
			a: previous.element.duration,
			b: trimAmount,
		});
		const nextNextStartTime = addMediaTime({
			a: next.element.startTime,
			b: trimAmount,
		});
		const nextNextDuration = subMediaTime({
			a: next.element.duration,
			b: trimAmount,
		});
		const handoffTime = subMediaTime({ a: outStart, b: trimAmount });
		const nextOutStartTime = subMediaTime({
			a: handoffTime,
			b: previous.element.startTime,
		});
		const nextInStartTime = inTransition.startTime ?? ZERO_MEDIA_TIME;

		const previousTransitions = {
			...(previous.element.transitions ?? {}),
			out: {
				...outTransition,
				startTime: mediaTime({ ticks: Math.max(0, nextOutStartTime) }),
			},
		};
		const previousElement = {
			...previous.element,
			duration: nextPreviousDuration,
			transitions: previousTransitions,
		};
		const nextElement = {
			...next.element,
			startTime: nextNextStartTime,
			duration: nextNextDuration,
			trimStart: addMediaTime({
				a: next.element.trimStart,
				b: trimAmount,
			}),
			transitions: {
				...(next.element.transitions ?? {}),
				in: {
					...inTransition,
					startTime: nextInStartTime,
				},
			},
		};

		const previousPatch: TextTransitionArrangeUpdate["patch"] = {
			duration: nextPreviousDuration,
			transitions: previousTransitions,
			animations: buildTransitionAnimationsFromElement({
				element: previousElement,
			}),
		};
		const nextPatch: TextTransitionArrangeUpdate["patch"] = {
			startTime: nextNextStartTime,
			duration: nextNextDuration,
			trimStart: nextElement.trimStart,
			transitions: nextElement.transitions,
			animations: buildTransitionAnimationsFromElement({
				element: nextElement,
			}),
		};

		mergeUpdate({ updates, entry: previous, patch: previousPatch });
		mergeUpdate({ updates, entry: next, patch: nextPatch });
		working[index] = { ...previous, element: previousElement };
		working[index + 1] = { ...next, element: nextElement };
	}

	return [...updates.values()];
}

function sortEntries(
	entries: TextTransitionArrangeEntry[],
): TextTransitionArrangeEntry[] {
	return entries
		.map((entry, index) => ({ entry, index }))
		.sort(
			(left, right) =>
				left.entry.element.startTime - right.entry.element.startTime ||
				left.index - right.index,
		)
		.map(({ entry }) => entry);
}

function entryKey(entry: TextTransitionArrangeEntry): string {
	return `${entry.trackId}:${entry.element.id}`;
}

function mergeUpdate({
	updates,
	entry,
	patch,
}: {
	updates: Map<string, TextTransitionArrangeUpdate>;
	entry: TextTransitionArrangeEntry;
	patch: TextTransitionArrangeUpdate["patch"];
}) {
	const key = entryKey(entry);
	const current = updates.get(key);
	updates.set(key, {
		trackId: entry.trackId,
		elementId: entry.element.id,
		patch: { ...(current?.patch ?? {}), ...patch },
	});
}
