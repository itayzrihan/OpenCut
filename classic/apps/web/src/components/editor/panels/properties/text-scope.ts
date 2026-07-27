import type { ParamValue } from "@/params";
import type { BlendMode } from "@/rendering";
import { DEFAULTS } from "@/timeline/defaults";
import type {
	TextCaptionRevealMode,
	TextElement,
	TextRowOverride,
	TextWordDirection,
	TextWordRun,
	TextWordStyle,
	TextWordTransitionIn,
} from "@/timeline";
import { normalizeTextFontWeight } from "@/text/primitives";
import { mediaTime } from "@/wasm";

export type TextOverrideScope =
	| { type: "layer" }
	| { type: "row"; lineIndex: number }
	| { type: "word"; wordId: string }
	| { type: "words"; wordIds: string[] };

export type TextScopedSettings = {
	revealMode?: TextCaptionRevealMode;
	transitionIn?: TextWordTransitionIn;
	wordAnimationId?: string;
	accentColor?: string;
	wordDirection?: TextWordDirection;
	glowerEnabled?: boolean;
	glowerDirection?: TextWordDirection;
	lightningStormEnabled?: boolean;
	glitchyEnabled?: boolean;
	style?: TextWordStyle;
};

export function getWordRuns({
	element,
}: {
	element: TextElement;
}): TextWordRun[] {
	if (element.wordRuns?.length) {
		return element.wordRuns;
	}

	const content =
		typeof element.params.content === "string" ? element.params.content : "";
	const entries = content.split("\n").flatMap((line, lineIndex) =>
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

export function getTextRows({ wordRuns }: { wordRuns: TextWordRun[] }) {
	const groups = new Map<number, string[]>();
	for (const word of wordRuns) {
		const lineIndex = word.lineIndex ?? 0;
		groups.set(lineIndex, [...(groups.get(lineIndex) ?? []), word.text]);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left - right)
		.map(([lineIndex, words]) => ({
			lineIndex,
			label: `Row ${lineIndex + 1}: ${words.join(" ")}`,
		}));
}

export function getRowOverride({
	element,
	lineIndex,
}: {
	element: TextElement;
	lineIndex: number;
}): TextRowOverride | undefined {
	return element.textRowOverrides?.find(
		(override) => override.lineIndex === lineIndex,
	);
}

export function mergeRowOverride({
	overrides,
	lineIndex,
	patch,
}: {
	overrides: TextRowOverride[] | undefined;
	lineIndex: number;
	patch: TextScopedSettings;
}): TextRowOverride[] {
	const existing = overrides?.find(
		(override) => override.lineIndex === lineIndex,
	);
	const nextOverride: TextRowOverride = {
		id: existing?.id ?? `row-${lineIndex}`,
		lineIndex,
		...existing,
		...patch,
		style: patch.style
			? { ...(existing?.style ?? {}), ...patch.style }
			: existing?.style,
	};
	const others = (overrides ?? []).filter(
		(override) => override.lineIndex !== lineIndex,
	);
	return [...others, nextOverride].sort(
		(left, right) => left.lineIndex - right.lineIndex,
	);
}

export function mergeWordOverride({
	word,
	patch,
}: {
	word: TextWordRun;
	patch: TextScopedSettings;
}): TextWordRun {
	return {
		...word,
		...patch,
		style: patch.style ? { ...(word.style ?? {}), ...patch.style } : word.style,
	};
}

export function buildScopedTextPatch({
	element,
	scope,
	patch,
}: {
	element: TextElement;
	scope: TextOverrideScope;
	patch: TextScopedSettings;
}): Partial<TextElement> {
	const wordRuns = getWordRuns({ element });

	if (scope.type === "row") {
		return {
			wordRuns,
			textRowOverrides: mergeRowOverride({
				overrides: element.textRowOverrides,
				lineIndex: scope.lineIndex,
				patch,
			}),
		};
	}

	if (scope.type === "word") {
		return {
			wordRuns: wordRuns.map((word) =>
				word.id === scope.wordId ? mergeWordOverride({ word, patch }) : word,
			),
		};
	}

	if (scope.type === "words") {
		const wordIds = new Set(scope.wordIds);
		return {
			wordRuns: wordRuns.map((word) =>
				wordIds.has(word.id) ? mergeWordOverride({ word, patch }) : word,
			),
		};
	}

	return {
		...(patch.revealMode !== undefined
			? { captionRevealMode: patch.revealMode }
			: {}),
		...(patch.transitionIn !== undefined
			? { captionTransitionIn: patch.transitionIn }
			: {}),
		...(patch.wordAnimationId !== undefined
			? { captionWordAnimationId: patch.wordAnimationId }
			: {}),
		...(patch.accentColor !== undefined
			? { captionAccentColor: patch.accentColor }
			: {}),
		...(patch.wordDirection !== undefined
			? { captionWordDirection: patch.wordDirection }
			: {}),
		...(patch.glowerEnabled !== undefined
			? { captionGlowerEnabled: patch.glowerEnabled }
			: {}),
		...(patch.glowerDirection !== undefined
			? { captionGlowerDirection: patch.glowerDirection }
			: {}),
		...(patch.lightningStormEnabled !== undefined
			? { captionLightningStormEnabled: patch.lightningStormEnabled }
			: {}),
		...(patch.glitchyEnabled !== undefined
			? { captionGlitchyEnabled: patch.glitchyEnabled }
			: {}),
	};
}

export function clearScopedTextOverride({
	element,
	scope,
}: {
	element: TextElement;
	scope: TextOverrideScope;
}): Partial<TextElement> {
	const wordRuns = getWordRuns({ element });

	if (scope.type === "row") {
		return {
			wordRuns,
			textRowOverrides: (element.textRowOverrides ?? []).filter(
				(override) => override.lineIndex !== scope.lineIndex,
			),
		};
	}

	if (scope.type === "word") {
		return {
			wordRuns: wordRuns.map((word) =>
				word.id === scope.wordId
					? {
							id: word.id,
							text: word.text,
							lineIndex: word.lineIndex,
							startTime: word.startTime,
							endTime: word.endTime,
						}
					: word,
			),
		};
	}

	if (scope.type === "words") {
		const wordIds = new Set(scope.wordIds);
		return {
			wordRuns: wordRuns.map((word) =>
				wordIds.has(word.id)
					? {
							id: word.id,
							text: word.text,
							lineIndex: word.lineIndex,
							startTime: word.startTime,
							endTime: word.endTime,
						}
					: word,
			),
		};
	}

	return {};
}

export function getScopedSettings({
	element,
	scope,
}: {
	element: TextElement;
	scope: TextOverrideScope;
}) {
	const wordRuns = getWordRuns({ element });
	const scopedWord =
		scope.type === "word"
			? wordRuns.find((word) => word.id === scope.wordId)
			: scope.type === "words"
				? wordRuns.find((word) => scope.wordIds.includes(word.id))
				: undefined;
	const scopedRow =
		scope.type === "row"
			? getRowOverride({ element, lineIndex: scope.lineIndex })
			: scopedWord
				? getRowOverride({ element, lineIndex: scopedWord.lineIndex })
				: undefined;

	return {
		word: scopedWord,
		rowOverride: scopedRow,
		revealMode:
			scopedWord?.revealMode ??
			scopedRow?.revealMode ??
			element.captionRevealMode,
		transitionIn:
			scopedWord?.transitionIn ??
			scopedRow?.transitionIn ??
			element.captionTransitionIn,
		wordAnimationId:
			scopedWord?.wordAnimationId ??
			scopedRow?.wordAnimationId ??
			element.captionWordAnimationId,
		accentColor:
			scopedWord?.accentColor ??
			scopedRow?.accentColor ??
			element.captionAccentColor,
		wordDirection:
			scopedWord?.wordDirection ??
			scopedRow?.wordDirection ??
			element.captionWordDirection,
		glowerEnabled:
			scopedWord?.glowerEnabled ??
			scopedRow?.glowerEnabled ??
			element.captionGlowerEnabled,
		glowerDirection:
			scopedWord?.glowerDirection ??
			scopedRow?.glowerDirection ??
			element.captionGlowerDirection,
		lightningStormEnabled:
			scopedWord?.lightningStormEnabled ??
			scopedRow?.lightningStormEnabled ??
			element.captionLightningStormEnabled,
		glitchyEnabled:
			scopedWord?.glitchyEnabled ??
			scopedRow?.glitchyEnabled ??
			element.captionGlitchyEnabled,
		style:
			scope.type === "word" || scope.type === "words"
				? scopedWord?.style
				: scope.type === "row"
					? scopedRow?.style
					: undefined,
		inheritedStyle:
			scope.type === "word" || scope.type === "words"
				? scopedRow?.style
				: undefined,
	};
}

export function hasScopedTextOverride({
	element,
	scope,
}: {
	element: TextElement;
	scope: TextOverrideScope;
}) {
	if (scope.type === "row") {
		return !!getRowOverride({ element, lineIndex: scope.lineIndex });
	}
	if (scope.type === "word") {
		const word = getWordRuns({ element }).find(
			(run) => run.id === scope.wordId,
		);
		return !!(
			word?.style ||
			word?.revealMode ||
			word?.transitionIn ||
			word?.wordAnimationId ||
			word?.accentColor ||
			word?.wordDirection ||
			word?.glowerEnabled !== undefined ||
			word?.glowerDirection
			|| word?.lightningStormEnabled !== undefined
			|| word?.glitchyEnabled !== undefined
		);
	}
	if (scope.type === "words") {
		const wordIds = new Set(scope.wordIds);
		return getWordRuns({ element }).some(
			(word) =>
				wordIds.has(word.id) &&
				!!(
					word.style ||
					word.revealMode ||
					word.transitionIn ||
					word.wordAnimationId ||
					word.accentColor ||
					word.wordDirection ||
					word.glowerEnabled !== undefined ||
					word.glowerDirection
					|| word.lightningStormEnabled !== undefined
					|| word.glitchyEnabled !== undefined
				),
		);
	}
	return false;
}

export function textParamToScopedPatch({
	key,
	value,
}: {
	key: string;
	value: ParamValue;
}): TextScopedSettings | null {
	switch (key) {
		case "fontFamily":
			return {
				style: { fontFamily: typeof value === "string" ? value : "Arial" },
			};
		case "fontSize":
			return { style: { fontSize: typeof value === "number" ? value : 15 } };
		case "color":
			return {
				style: { color: typeof value === "string" ? value : "#ffffff" },
			};
		case "textAlign":
			return {
				style: {
					textAlign:
						value === "left" || value === "center" || value === "right"
							? value
							: "center",
				},
			};
		case "fontWeight":
			return {
				style: {
					fontWeight: normalizeTextFontWeight({
						value,
						fallback: "normal",
					}),
				},
			};
		case "fontStyle":
			return { style: { fontStyle: value === "italic" ? "italic" : "normal" } };
		case "textDecoration":
			return {
				style: {
					textDecoration:
						value === "underline" || value === "line-through" ? value : "none",
				},
			};
		case "letterSpacing":
			return {
				style: { letterSpacing: typeof value === "number" ? value : 0 },
			};
		case "lineHeight":
			return { style: { lineHeight: typeof value === "number" ? value : 1.2 } };
		case "stroke.enabled":
			return {
				style: {
					strokeWidth: value ? DEFAULTS.text.stroke.width : 0,
				},
			};
		case "stroke.color":
			return {
				style: {
					strokeColor:
						typeof value === "string" ? value : DEFAULTS.text.stroke.color,
				},
			};
		case "stroke.width":
			return {
				style: {
					strokeWidth:
						typeof value === "number" ? value : DEFAULTS.text.stroke.width,
				},
			};
		case "shadow.enabled":
			return {
				style: {
					shadowBlur: value ? DEFAULTS.text.shadow.blur : 0,
					shadowOffsetX: value ? DEFAULTS.text.shadow.offsetX : 0,
					shadowOffsetY: value ? DEFAULTS.text.shadow.offsetY : 0,
				},
			};
		case "shadow.color":
			return {
				style: {
					shadowColor:
						typeof value === "string" ? value : DEFAULTS.text.shadow.color,
				},
			};
		case "shadow.blur":
			return {
				style: {
					shadowBlur:
						typeof value === "number" ? value : DEFAULTS.text.shadow.blur,
				},
			};
		case "shadow.offsetX":
			return {
				style: {
					shadowOffsetX:
						typeof value === "number" ? value : DEFAULTS.text.shadow.offsetX,
				},
			};
		case "shadow.offsetY":
			return {
				style: {
					shadowOffsetY:
						typeof value === "number" ? value : DEFAULTS.text.shadow.offsetY,
				},
			};
		case "transform.positionX":
			return { style: { offsetX: typeof value === "number" ? value : 0 } };
		case "transform.positionY":
			return { style: { offsetY: typeof value === "number" ? value : 0 } };
		case "transform.scaleX":
			return { style: { scaleX: typeof value === "number" ? value : 1 } };
		case "transform.scaleY":
			return { style: { scaleY: typeof value === "number" ? value : 1 } };
		case "transform.rotate":
			return { style: { rotate: typeof value === "number" ? value : 0 } };
		case "opacity":
			return { style: { opacity: typeof value === "number" ? value : 1 } };
		case "blendMode":
			return { style: { blendMode: toBlendMode(value) } };
		case "background.enabled":
			return { style: { backgroundEnabled: Boolean(value) } };
		case "background.color":
			return {
				style: {
					backgroundColor: typeof value === "string" ? value : "#000000",
				},
			};
		case "background.cornerRadius":
			return {
				style: {
					backgroundCornerRadius: typeof value === "number" ? value : 0,
				},
			};
		case "background.paddingX":
			return {
				style: { backgroundPaddingX: typeof value === "number" ? value : 0 },
			};
		case "background.paddingY":
			return {
				style: { backgroundPaddingY: typeof value === "number" ? value : 0 },
			};
		case "background.offsetX":
			return {
				style: { backgroundOffsetX: typeof value === "number" ? value : 0 },
			};
		case "background.offsetY":
			return {
				style: { backgroundOffsetY: typeof value === "number" ? value : 0 },
			};
		default:
			return null;
	}
}

export function readScopedTextParamValue({
	element,
	scope,
	key,
	fallbackValue,
}: {
	element: TextElement;
	scope: TextOverrideScope;
	key: string;
	fallbackValue: ParamValue;
}): ParamValue {
	const settings = getScopedSettings({ element, scope });
	const style = settings.style ?? {};
	const inheritedStyle = settings.inheritedStyle ?? {};

	switch (key) {
		case "fontFamily":
		case "fontSize":
		case "color":
		case "textAlign":
		case "fontWeight":
		case "fontStyle":
		case "textDecoration":
		case "letterSpacing":
		case "lineHeight":
			return style[key] ?? inheritedStyle[key] ?? fallbackValue;
		case "stroke.enabled":
			return (style.strokeWidth ?? inheritedStyle.strokeWidth ?? 0) > 0;
		case "stroke.color":
			return (
				style.strokeColor ??
				inheritedStyle.strokeColor ??
				DEFAULTS.text.stroke.color
			);
		case "stroke.width":
			return (
				style.strokeWidth ??
				inheritedStyle.strokeWidth ??
				DEFAULTS.text.stroke.width
			);
		case "shadow.enabled":
			return (
				(style.shadowBlur ?? inheritedStyle.shadowBlur ?? 0) > 0 ||
				(style.shadowOffsetX ?? inheritedStyle.shadowOffsetX ?? 0) !== 0 ||
				(style.shadowOffsetY ?? inheritedStyle.shadowOffsetY ?? 0) !== 0
			);
		case "shadow.color":
			return (
				style.shadowColor ??
				inheritedStyle.shadowColor ??
				DEFAULTS.text.shadow.color
			);
		case "shadow.blur":
			return (
				style.shadowBlur ??
				inheritedStyle.shadowBlur ??
				DEFAULTS.text.shadow.blur
			);
		case "shadow.offsetX":
			return (
				style.shadowOffsetX ??
				inheritedStyle.shadowOffsetX ??
				DEFAULTS.text.shadow.offsetX
			);
		case "shadow.offsetY":
			return (
				style.shadowOffsetY ??
				inheritedStyle.shadowOffsetY ??
				DEFAULTS.text.shadow.offsetY
			);
		case "transform.positionX":
			return style.offsetX ?? inheritedStyle.offsetX ?? 0;
		case "transform.positionY":
			return style.offsetY ?? inheritedStyle.offsetY ?? 0;
		case "transform.scaleX":
			return (
				style.scaleX ??
				inheritedStyle.scaleX ??
				style.scale ??
				inheritedStyle.scale ??
				1
			);
		case "transform.scaleY":
			return (
				style.scaleY ??
				inheritedStyle.scaleY ??
				style.scale ??
				inheritedStyle.scale ??
				1
			);
		case "transform.rotate":
			return style.rotate ?? inheritedStyle.rotate ?? 0;
		case "opacity":
			return style.opacity ?? inheritedStyle.opacity ?? 1;
		case "blendMode":
			return style.blendMode ?? inheritedStyle.blendMode ?? "normal";
		case "background.enabled":
			return (
				style.backgroundEnabled ?? inheritedStyle.backgroundEnabled ?? false
			);
		case "background.color":
			return (
				style.backgroundColor ?? inheritedStyle.backgroundColor ?? "#000000"
			);
		case "background.cornerRadius":
			return (
				style.backgroundCornerRadius ??
				inheritedStyle.backgroundCornerRadius ??
				0
			);
		case "background.paddingX":
			return style.backgroundPaddingX ?? inheritedStyle.backgroundPaddingX ?? 0;
		case "background.paddingY":
			return style.backgroundPaddingY ?? inheritedStyle.backgroundPaddingY ?? 0;
		case "background.offsetX":
			return style.backgroundOffsetX ?? inheritedStyle.backgroundOffsetX ?? 0;
		case "background.offsetY":
			return style.backgroundOffsetY ?? inheritedStyle.backgroundOffsetY ?? 0;
		default:
			return fallbackValue;
	}
}

function toBlendMode(value: ParamValue): BlendMode {
	return typeof value === "string" && isBlendMode(value) ? value : "normal";
}

function isBlendMode(value: string): value is BlendMode {
	return (
		value === "normal" ||
		value === "darken" ||
		value === "multiply" ||
		value === "color-burn" ||
		value === "lighten" ||
		value === "screen" ||
		value === "plus-lighter" ||
		value === "color-dodge" ||
		value === "overlay" ||
		value === "soft-light" ||
		value === "hard-light" ||
		value === "difference" ||
		value === "exclusion" ||
		value === "hue" ||
		value === "saturation" ||
		value === "color" ||
		value === "luminosity"
	);
}
