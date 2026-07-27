import { clampAnimationsToDuration } from "@/animation";
import {
	clampRetimeRate,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type {
	RetimeConfig,
	SceneTracks,
	TextElement,
	TextWordRun,
	TimelineElement,
} from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { mediaTime, ZERO_MEDIA_TIME, roundMediaTime } from "@/wasm";
import {
	fitTextLayerWordsToSpan,
	reconcileTextContentWords,
	textLayerDurationForWords,
} from "opencut-wasm";

type ElementUpdateField = keyof TimelineElement | string;

export interface ElementUpdateContext {
	tracks: SceneTracks;
	trackId: string;
}

interface ElementUpdateRuleResult {
	element: TimelineElement;
	changedFields?: ElementUpdateField[];
}

interface ElementUpdateRuleParams {
	element: TimelineElement;
	originalElement: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}

interface ElementUpdateRule {
	triggers: ElementUpdateField[];
	apply: (params: ElementUpdateRuleParams) => ElementUpdateRuleResult;
}

const deriveRules: ElementUpdateRule[] = [
	{
		triggers: ["retime"],
		apply: ({ element, originalElement, patch }) => {
			if (!("retime" in patch) || !isRetimableElement(element)) {
				return { element };
			}

			const nextRetime = patch.retime
				? {
						...patch.retime,
						rate: clampRetimeRate({ rate: patch.retime.rate }),
					}
				: undefined;

			const sourceDuration = getSourceDuration({
				trimStart: originalElement.trimStart,
				trimEnd: originalElement.trimEnd,
				duration: originalElement.duration,
				sourceDuration: isRetimableElement(originalElement)
					? originalElement.sourceDuration
					: undefined,
				retime: isRetimableElement(originalElement)
					? originalElement.retime
					: undefined,
			});
			const visibleSourceSpan = Math.max(
				0,
				sourceDuration - element.trimStart - element.trimEnd,
			);
			const nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});

			return {
				element: {
					...element,
					retime: nextRetime,
					duration: nextDuration,
				},
				changedFields: ["retime", "duration"],
			};
		},
	},
];

const enforceRules: ElementUpdateRule[] = [
	{
		triggers: ["duration"],
		apply: ({ element }) => ({
			element: {
				...element,
				animations: clampAnimationsToDuration({
					animations: element.animations,
					duration: element.duration,
				}),
			},
		}),
	},
	{
		triggers: ["startTime"],
		apply: ({ element, context }) => {
			const requestedStartTime =
				element.startTime < ZERO_MEDIA_TIME
					? ZERO_MEDIA_TIME
					: element.startTime;
			if (context.trackId !== context.tracks.main.id) {
				return {
					element: {
						...element,
						startTime: requestedStartTime,
					},
				};
			}

			const earliestElement = context.tracks.main.elements
				.filter((candidate) => candidate.id !== element.id)
				.reduce<TimelineElement | null>((earliest, candidate) => {
					if (!earliest || candidate.startTime < earliest.startTime) {
						return candidate;
					}
					return earliest;
				}, null);

			return {
				element: {
					...element,
					startTime:
						!earliestElement || requestedStartTime <= earliestElement.startTime
							? ZERO_MEDIA_TIME
							: requestedStartTime,
				},
			};
		},
	},
];

export function applyElementUpdate({
	element,
	patch,
	context,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}): TimelineElement {
	let nextElement = {
		...element,
		...patch,
		params: {
			...element.params,
			...(patch.params ?? {}),
		},
	} as TimelineElement;
	const textPatch = patch as Partial<TextElement>;
	let didExtendTextLayerForWords = false;
	if (
		element.type === "text" &&
		nextElement.type === "text" &&
		textPatch.wordRuns !== undefined &&
		!Object.prototype.hasOwnProperty.call(patch, "duration")
	) {
		const duration = mediaTime({
			ticks: textLayerDurationForWords({
				duration: nextElement.duration,
				wordRuns: textPatch.wordRuns,
			}),
		});
		if (duration !== nextElement.duration) {
			nextElement = { ...nextElement, duration };
			didExtendTextLayerForWords = true;
		}
	}
	if (
		element.type === "text" &&
		nextElement.type === "text" &&
		textPatch.wordRuns === undefined &&
		Object.prototype.hasOwnProperty.call(patch.params ?? {}, "content") &&
		(element.wordRuns?.length ?? 0) > 0
	) {
		const content =
			typeof nextElement.params.content === "string"
				? nextElement.params.content
				: "";
		const reconciledWords = reconcileTextContentWords({
			content,
			duration: nextElement.duration,
			previousWords: element.wordRuns ?? [],
		});
		nextElement = {
			...nextElement,
			wordRuns: reconciledWords.map<TextWordRun>((word) => {
				const previous =
					word.previousWordIndex == null
						? undefined
						: element.wordRuns?.[word.previousWordIndex];
				return {
					...previous,
					id: word.id,
					text: word.text,
					lineIndex: word.lineIndex,
					startTime:
						word.startTime == null
							? undefined
							: mediaTime({ ticks: word.startTime }),
					endTime:
						word.endTime == null
							? undefined
							: mediaTime({ ticks: word.endTime }),
				};
			}),
		};
	}
	if (
		element.type === "text" &&
		nextElement.type === "text" &&
		textPatch.wordRuns === undefined &&
		!Object.prototype.hasOwnProperty.call(patch.params ?? {}, "content") &&
		(element.wordRuns?.length ?? 0) > 0 &&
		(Object.prototype.hasOwnProperty.call(patch, "trimStart") ||
			Object.prototype.hasOwnProperty.call(patch, "trimEnd")) &&
		(element.startTime !== nextElement.startTime ||
			element.duration !== nextElement.duration)
	) {
		const fittedWords = fitTextLayerWordsToSpan({
			previousStartTime: element.startTime,
			nextStartTime: nextElement.startTime,
			nextDuration: nextElement.duration,
			wordRuns: element.wordRuns ?? [],
		});
		const wordRuns = fittedWords.flatMap<TextWordRun>((word) => {
			const previous = element.wordRuns?.[word.previousWordIndex];
			if (!previous) return [];
			return [
				{
					...previous,
					lineIndex: word.lineIndex,
					startTime:
						word.startTime == null
							? undefined
							: mediaTime({ ticks: word.startTime }),
					endTime:
						word.endTime == null
							? undefined
							: mediaTime({ ticks: word.endTime }),
				},
			];
		});
		nextElement = {
			...nextElement,
			params: {
				...nextElement.params,
				content: textContentFromWordRuns({ wordRuns }),
			},
			wordRuns,
		};
	}
	const changedFields = new Set(Object.keys(patch) as ElementUpdateField[]);
	if (didExtendTextLayerForWords) changedFields.add("duration");

	for (const rule of deriveRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		const result = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		});
		nextElement = result.element;
		for (const field of result.changedFields ?? []) {
			changedFields.add(field);
		}
	}

	for (const rule of enforceRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		nextElement = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		}).element;
	}

	return nextElement;
}

function textContentFromWordRuns({
	wordRuns,
}: {
	wordRuns: NonNullable<Extract<TimelineElement, { type: "text" }>["wordRuns"]>;
}) {
	const lines = new Map<number, string[]>();
	for (const word of wordRuns) {
		lines.set(word.lineIndex, [
			...(lines.get(word.lineIndex) ?? []),
			word.text,
		]);
	}
	return [...lines.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, words]) => words.join(" "))
		.join("\n");
}

function shouldApplyRule({
	rule,
	changedFields,
}: {
	rule: ElementUpdateRule;
	changedFields: Set<ElementUpdateField>;
}): boolean {
	return rule.triggers.some((trigger) => changedFields.has(trigger));
}

function getSourceDuration({
	trimStart,
	trimEnd,
	duration,
	sourceDuration,
	retime,
}: {
	trimStart: number;
	trimEnd: number;
	duration: number;
	sourceDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (typeof sourceDuration === "number") {
		return sourceDuration;
	}

	return (
		trimStart +
		getSourceSpanAtClipTime({
			clipTime: duration,
			retime,
		}) +
		trimEnd
	);
}
