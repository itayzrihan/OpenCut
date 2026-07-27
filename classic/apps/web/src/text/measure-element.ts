import { CORNER_RADIUS_MIN } from "@/text/background";
import { DEFAULTS } from "@/timeline/defaults";
import type { TextElement } from "@/timeline";
import type { TextRowOverride, TextWordRun, TextWordStyle } from "@/timeline";
import type { TextCaptionRevealMode, TextWordTransitionIn } from "@/timeline";
import type { TextBackground } from "@/text/background";
import { resolveColorAtTime, resolveNumberAtTime } from "@/animation/values";
import { mediaTime } from "@/wasm";
import { getTextVisualRect, type TextLayoutMeasurementContext } from "./layout";
import {
	buildTextFontString,
	measureTextLayout,
	normalizeTextFontWeight,
	type MeasuredTextLayout,
	type MeasuredWordGlyph,
	type MeasuredWordLine,
	type ResolvedTextShadow,
	type ResolvedTextStroke,
	type TextAlign,
	type TextDecoration,
	type TextFontStyle,
	type TextFontWeight,
	type TextLayoutParams,
} from "./primitives";
import { getCaptionWordAnimation } from "./caption-presets";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";

export interface ResolvedTextBackground extends TextBackground {
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export interface MeasuredTextElement extends MeasuredTextLayout {
	resolvedBackground: ResolvedTextBackground;
	visualRect: { left: number; top: number; width: number; height: number };
}

let textMeasurementContext: TextLayoutMeasurementContext | null = null;

class FallbackTextMetrics implements TextMetrics {
	width: number;
	actualBoundingBoxLeft = 0;
	actualBoundingBoxRight: number;
	fontBoundingBoxAscent: number;
	fontBoundingBoxDescent: number;
	actualBoundingBoxAscent: number;
	actualBoundingBoxDescent: number;
	emHeightAscent: number;
	emHeightDescent: number;
	hangingBaseline = 0;
	alphabeticBaseline = 0;
	ideographicBaseline = 0;

	constructor({
		text,
		fontSize,
		width,
	}: {
		text: string;
		fontSize: number;
		width?: number;
	}) {
		this.width = width ?? text.length * fontSize * 0.6;
		this.actualBoundingBoxRight = this.width;
		this.fontBoundingBoxAscent = fontSize * 0.8;
		this.fontBoundingBoxDescent = fontSize * 0.2;
		this.actualBoundingBoxAscent = fontSize * 0.8;
		this.actualBoundingBoxDescent = fontSize * 0.2;
		this.emHeightAscent = fontSize * 0.8;
		this.emHeightDescent = fontSize * 0.2;
	}
}

function createFallbackTextMeasurementContext(): TextLayoutMeasurementContext {
	const context: TextLayoutMeasurementContext = {
		font: "15px sans-serif",
		textBaseline: "middle",
		save() {},
		restore() {},
		measureText(text: string): TextMetrics {
			const fontSize = Number.parseFloat(
				this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? "15",
			);
			return new FallbackTextMetrics({ text, fontSize });
		},
	};

	return context;
}

export function getTextMeasurementContext(): TextLayoutMeasurementContext {
	if (textMeasurementContext) {
		return textMeasurementContext;
	}

	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(1, 1);
		const context = canvas.getContext("2d");
		if (context) {
			textMeasurementContext = context;
			return context;
		}
	}

	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (context) {
			textMeasurementContext = context;
			return context;
		}
	}

	textMeasurementContext = createFallbackTextMeasurementContext();
	return textMeasurementContext;
}

export function measureTextElement({
	element,
	canvasHeight,
	localTime,
	ctx,
}: {
	element: TextElement;
	canvasHeight: number;
	localTime: number;
	ctx: TextLayoutMeasurementContext;
}): MeasuredTextElement {
	const text = resolveTextEffectParamsAtTime({
		text: buildTextLayoutParamsFromElement({ element }),
		element,
		localTime,
	});
	const measuredLayout = measureTextLayout({
		text,
		canvasHeight,
		ctx,
	});
	const measuredTextWithWords = measureWordRunsLayout({
		element,
		text,
		measuredLayout,
		canvasHeight,
		localTime,
		ctx,
	});

	const bg = buildTextBackgroundFromElement({ element });
	const resolvedBackground: ResolvedTextBackground = {
		...bg,
		paddingX: resolveNumberAtTime({
			baseValue: bg.paddingX ?? DEFAULTS.text.background.paddingX,
			animations: element.animations,
			propertyPath: "background.paddingX",
			localTime,
		}),
		paddingY: resolveNumberAtTime({
			baseValue: bg.paddingY ?? DEFAULTS.text.background.paddingY,
			animations: element.animations,
			propertyPath: "background.paddingY",
			localTime,
		}),
		offsetX: resolveNumberAtTime({
			baseValue: bg.offsetX ?? DEFAULTS.text.background.offsetX,
			animations: element.animations,
			propertyPath: "background.offsetX",
			localTime,
		}),
		offsetY: resolveNumberAtTime({
			baseValue: bg.offsetY ?? DEFAULTS.text.background.offsetY,
			animations: element.animations,
			propertyPath: "background.offsetY",
			localTime,
		}),
		cornerRadius: resolveNumberAtTime({
			baseValue: bg.cornerRadius ?? CORNER_RADIUS_MIN,
			animations: element.animations,
			propertyPath: "background.cornerRadius",
			localTime,
		}),
	};
	const resolvedStroke = resolveTextStroke({
		text,
	});
	const resolvedShadow = resolveTextShadow({
		text,
	});

	const visualRect = inflateTextVisualRectForEffects({
		rect: getTextVisualRect({
			textAlign: text.textAlign,
			block: measuredTextWithWords.block,
			background: resolvedBackground,
			fontSizeRatio: measuredTextWithWords.fontSizeRatio,
		}),
		stroke: resolvedStroke,
		shadow: resolvedShadow,
	});

	return {
		...measuredTextWithWords,
		stroke: resolvedStroke,
		shadow: resolvedShadow,
		resolvedBackground,
		visualRect,
	};
}

function resolveTextEffectParamsAtTime({
	text,
	element,
	localTime,
}: {
	text: TextLayoutParams;
	element: TextElement;
	localTime: number;
}): TextLayoutParams {
	return {
		...text,
		strokeWidth: resolveNumberAtTime({
			baseValue: text.strokeWidth ?? 0,
			animations: element.animations,
			propertyPath: "stroke.width",
			localTime,
		}),
		strokeColor: resolveColorAtTime({
			baseColor: text.strokeColor ?? DEFAULTS.text.stroke.color,
			animations: element.animations,
			propertyPath: "stroke.color",
			localTime,
		}),
		shadowBlur: resolveNumberAtTime({
			baseValue: text.shadowBlur ?? 0,
			animations: element.animations,
			propertyPath: "shadow.blur",
			localTime,
		}),
		shadowColor: resolveColorAtTime({
			baseColor: text.shadowColor ?? DEFAULTS.text.shadow.color,
			animations: element.animations,
			propertyPath: "shadow.color",
			localTime,
		}),
		shadowOffsetX: resolveNumberAtTime({
			baseValue: text.shadowOffsetX ?? 0,
			animations: element.animations,
			propertyPath: "shadow.offsetX",
			localTime,
		}),
		shadowOffsetY: resolveNumberAtTime({
			baseValue: text.shadowOffsetY ?? 0,
			animations: element.animations,
			propertyPath: "shadow.offsetY",
			localTime,
		}),
	};
}

function resolveTextStroke({
	text,
}: {
	text: TextLayoutParams;
}): ResolvedTextStroke | null {
	const width = text.strokeWidth ?? 0;
	if (width <= 0) return null;
	return {
		color: text.strokeColor ?? DEFAULTS.text.stroke.color,
		width,
	};
}

function resolveTextShadow({
	text,
}: {
	text: TextLayoutParams;
}): ResolvedTextShadow | null {
	const shadow = {
		color: text.shadowColor ?? DEFAULTS.text.shadow.color,
		blur: text.shadowBlur ?? 0,
		offsetX: text.shadowOffsetX ?? 0,
		offsetY: text.shadowOffsetY ?? 0,
	};
	if (shadow.blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0) {
		return null;
	}
	return shadow;
}

function inflateTextVisualRectForEffects({
	rect,
	stroke,
	shadow,
}: {
	rect: MeasuredTextElement["visualRect"];
	stroke: ResolvedTextStroke | null;
	shadow: ResolvedTextShadow | null;
}): MeasuredTextElement["visualRect"] {
	const strokeOutset = (stroke?.width ?? 0) / 2;
	const shadowBlur = shadow?.blur ?? 0;
	const shadowOffsetX = shadow?.offsetX ?? 0;
	const shadowOffsetY = shadow?.offsetY ?? 0;
	const leftOutset = strokeOutset + shadowBlur + Math.max(0, -shadowOffsetX);
	const rightOutset = strokeOutset + shadowBlur + Math.max(0, shadowOffsetX);
	const topOutset = strokeOutset + shadowBlur + Math.max(0, -shadowOffsetY);
	const bottomOutset = strokeOutset + shadowBlur + Math.max(0, shadowOffsetY);

	return {
		left: rect.left - leftOutset,
		top: rect.top - topOutset,
		width: rect.width + leftOutset + rightOutset,
		height: rect.height + topOutset + bottomOutset,
	};
}

function measureWordRunsLayout({
	element,
	text,
	measuredLayout,
	canvasHeight,
	localTime,
	ctx,
}: {
	element: TextElement;
	text: TextLayoutParams;
	measuredLayout: MeasuredTextLayout;
	canvasHeight: number;
	localTime: number;
	ctx: TextLayoutMeasurementContext;
}): MeasuredTextLayout {
	if (!element.wordRuns?.length) {
		return measuredLayout;
	}

	const wordRuns = getRenderWordRuns({ element });
	const lineGroups = new Map<number, TextWordRun[]>();
	for (const run of wordRuns) {
		const line = run.lineIndex ?? 0;
		lineGroups.set(line, [...(lineGroups.get(line) ?? []), run]);
	}

	const lineIndexes = [...lineGroups.keys()].sort((a, b) => a - b);
	const wordLines: MeasuredWordLine[] = [];
	const lineMetrics: TextMetrics[] = [];
	const lineHeightPx = measuredLayout.lineHeightPx;
	let maxWidth = 0;
	let y = 0;
	let firstLineHeightPx = lineHeightPx;

	for (
		let visualLineIndex = 0;
		visualLineIndex < lineIndexes.length;
		visualLineIndex++
	) {
		const lineIndex = lineIndexes[visualLineIndex];
		const rowOverride = getRowOverride({ element, lineIndex });
		const rowStyle = rowOverride?.style;
		const rowTextStyle = { ...text, ...rowStyle };
		const spaceMetrics = measureStyledWord({
			ctx,
			text: " ",
			style: rowTextStyle,
			canvasHeight,
		}).metrics;
		const spaceWidth =
			spaceMetrics.width *
			Math.max(0.01, rowTextStyle.scaleX ?? rowTextStyle.scale ?? 1);
		const lineRuns = lineGroups.get(lineIndex) ?? [];
		const lineText = lineRuns.map((run) => run.text).join(" ");
		const lineDirection = resolveWordDirection({
			element,
			override: rowOverride?.wordDirection,
			text: lineText,
		});
		const sourceWords =
			lineDirection === "rtl" ? [...lineRuns].reverse() : lineRuns;
		const measuredWords = sourceWords.map((run) => {
			const wordAnimationId = resolveWordAnimationId({
				element,
				rowOverride,
				run,
			});
			const preset = getCaptionWordAnimation({ wordAnimationId });
			const revealMode = resolveRevealMode({
				elementMode:
					run.revealMode ??
					rowOverride?.revealMode ??
					element.captionRevealMode,
				presetMode: preset.revealMode,
			});
			const direction = resolveWordDirection({
				element,
				override: run.wordDirection ?? rowOverride?.wordDirection,
				text: run.text,
			});
			const style = resolveWordStyle({
				base: text,
				rowStyle,
				run,
				localTime,
				revealMode,
				transitionIn:
					run.transitionIn ??
					rowOverride?.transitionIn ??
					element.captionTransitionIn ??
					"none",
				preset,
				accentColor:
					run.accentColor ??
					rowOverride?.accentColor ??
					element.captionAccentColor,
				baseColor:
					typeof element.params.color === "string"
						? element.params.color
						: undefined,
			});
			const start = run.startTime ?? 0;
			const end = run.endTime ?? start;
			const glowerEnabled =
				run.glowerEnabled ??
				rowOverride?.glowerEnabled ??
				element.captionGlowerEnabled ??
				false;
			const lightningEnabled =
				run.lightningStormEnabled ??
				rowOverride?.lightningStormEnabled ??
				element.captionLightningStormEnabled ??
				false;
			const glitchyEnabled =
				run.glitchyEnabled ??
				rowOverride?.glitchyEnabled ??
				element.captionGlitchyEnabled ??
				false;
			const persistentProgress = (enabled: boolean) =>
				enabled
					? Math.max(0, Math.min(1, (localTime - start) / Math.max(0.001, end - start)))
					: 0;
			const glowerProgress = Math.max(
				persistentProgress(glowerEnabled),
				persistentProgress(lightningEnabled),
				persistentProgress(glitchyEnabled),
			);
			const glowerDirectionSetting =
				run.glowerDirection ??
				rowOverride?.glowerDirection ??
				element.captionGlowerDirection ??
				"auto";
			const measuredWord = measureStyledWord({
				ctx,
				text: run.text,
				style,
				canvasHeight,
			});
			return {
				run,
				direction,
				style,
				glowerProgress,
				glowerDirection:
					glowerDirectionSetting === "auto"
						? lineDirection
						: glowerDirectionSetting,
				lightningProgress: persistentProgress(lightningEnabled),
				glitchyProgress: persistentProgress(glitchyEnabled),
				lightningActive: lightningEnabled && localTime >= start && localTime < end,
				glitchyActive: glitchyEnabled && localTime >= start && localTime < end,
				drawText: resolveDrawText({
					run,
					style,
					localTime,
				}),
				layoutWidth:
					measuredWord.metrics.width *
					Math.max(0.01, style.scaleX ?? style.scale ?? 1),
				...measuredWord,
			};
		});
		const rowLineHeightPx = Math.max(
			lineHeightPx,
			...measuredWords.map(
				(word) =>
					word.scaledFontSize *
					(word.style.lineHeight ??
						rowTextStyle.lineHeight ??
						DEFAULTS.text.lineHeight),
			),
		);
		if (visualLineIndex === 0) {
			firstLineHeightPx = rowLineHeightPx;
		}
		const width = measuredWords.reduce(
			(total, word, index) =>
				total + word.layoutWidth + (index > 0 ? spaceWidth : 0),
			0,
		);
		maxWidth = Math.max(maxWidth, width);

		let x = 0;
		const textAlign = rowStyle?.textAlign ?? text.textAlign;
		if (textAlign === "center") x = -width / 2;
		if (textAlign === "right") x = -width;

		const words: MeasuredWordGlyph[] = measuredWords.map((word, index) => {
			if (index > 0) x += spaceWidth;
			const glyphX = x;
			x += word.layoutWidth;
			return {
				id: word.run.id,
				text: word.run.text,
				drawText: word.drawText,
				x: glyphX,
				y,
				width: word.metrics.width,
				layoutWidth: word.layoutWidth,
				metrics: word.metrics,
				fontString: word.fontString,
				scaledFontSize: word.scaledFontSize,
				letterSpacing:
					word.style.letterSpacing ??
					text.letterSpacing ??
					DEFAULTS.text.letterSpacing,
				color: word.style.color ?? "#ffffff",
				opacity: word.style.opacity ?? 1,
				scale: word.style.scale ?? 1,
				scaleX: word.style.scaleX ?? word.style.scale ?? 1,
				scaleY: word.style.scaleY ?? word.style.scale ?? 1,
				rotate: word.style.rotate ?? 0,
				blur: word.style.blur ?? 0,
				shadowBlur: word.style.shadowBlur ?? 0,
				shadowColor: word.style.shadowColor ?? word.style.color ?? "#ffffff",
				shadowOffsetX: word.style.shadowOffsetX ?? 0,
				shadowOffsetY: word.style.shadowOffsetY ?? 0,
				strokeWidth: word.style.strokeWidth ?? 0,
				strokeColor: word.style.strokeColor ?? "#000000",
				offsetX: word.style.offsetX ?? 0,
				offsetY: word.style.offsetY ?? 0,
				blendMode: word.style.blendMode ?? "normal",
				background: {
					enabled: word.style.backgroundEnabled ?? false,
					color: word.style.backgroundColor ?? "#000000",
					paddingX:
						(word.style.backgroundPaddingX ??
							DEFAULTS.text.background.paddingX) *
						((word.style.fontSize ?? text.fontSize) / 15),
					paddingY:
						(word.style.backgroundPaddingY ??
							DEFAULTS.text.background.paddingY) *
						((word.style.fontSize ?? text.fontSize) / 15),
					offsetX: word.style.backgroundOffsetX ?? 0,
					offsetY: word.style.backgroundOffsetY ?? 0,
					cornerRadius:
						word.style.backgroundCornerRadius ??
						DEFAULTS.text.background.cornerRadius,
				},
				direction: word.direction,
				textDecoration:
					word.style.textDecoration ?? text.textDecoration ?? "none",
				glowerProgress: word.glowerProgress,
				glowerDirection: word.glowerDirection,
				lightningProgress: word.lightningProgress,
				glitchyProgress: word.glitchyProgress,
				lightningActive: word.lightningActive,
				glitchyActive: word.glitchyActive,
				gradient:
					element.params.textFillMode === "gradient"
						? {
								startColor:
									typeof element.params.gradientStartColor === "string"
										? element.params.gradientStartColor
										: "#ffffff",
								endColor:
									typeof element.params.gradientEndColor === "string"
										? element.params.gradientEndColor
										: "#7c3aed",
								angle:
									typeof element.params.gradientAngle === "number"
										? element.params.gradientAngle
										: 0,
							}
						: undefined,
			};
		});
		wordLines.push({ y, width, words });
		lineMetrics.push(new FallbackTextMetrics({ text: "", fontSize: 0, width }));
		y += rowLineHeightPx;
	}

	const block = {
		maxWidth,
		height: Math.max(1, y),
		visualCenterOffset: y / 2 - firstLineHeightPx / 2,
	};

	return {
		...measuredLayout,
		lines: wordLines.map((line) =>
			line.words.map((word) => word.text).join(" "),
		),
		lineMetrics,
		block,
		wordLines: wordLines.map((line) => ({
			...line,
			y: line.y - block.visualCenterOffset,
			words: line.words.map((word) => ({
				...word,
				y: word.y - block.visualCenterOffset,
			})),
		})),
	};
}

function getRenderWordRuns({ element }: { element: TextElement }): TextWordRun[] {
	const runs = element.wordRuns ?? [];
	if (runs.length === 0) return runs;

	const fallbackWordDuration =
		runs.length > 0 ? element.duration / runs.length : 0;
	return runs.map((run, index) => {
		if (
			run.startTime != null &&
			run.endTime != null &&
			run.endTime > run.startTime
		) {
			return run;
		}

		const fallbackStart = mediaTime({
			ticks: Math.round(index * fallbackWordDuration),
		});
		const fallbackEnd = mediaTime({
			ticks: Math.max(
				Math.round((index + 1) * fallbackWordDuration),
				fallbackStart + 1,
			),
		});
		const startTime = run.startTime ?? fallbackStart;
		const endTime =
			run.endTime != null && run.endTime > startTime
				? run.endTime
				: fallbackEnd;

		return {
			...run,
			startTime,
			endTime,
		};
	});
}

function resolveWordStyle({
	base,
	rowStyle,
	run,
	localTime,
	revealMode,
	transitionIn,
	preset,
	accentColor,
	baseColor,
}: {
	base: TextLayoutParams;
	rowStyle: TextWordStyle | undefined;
	run: TextWordRun;
	localTime: number;
	revealMode: TextCaptionRevealMode;
	transitionIn: TextWordTransitionIn;
	preset: ReturnType<typeof getCaptionWordAnimation>;
	accentColor: string | undefined;
	baseColor: string | undefined;
}): TextWordStyle & TextLayoutParams {
	const start = run.startTime ?? 0;
	const end = run.endTime ?? start;
	const isActive = localTime >= start && localTime < end;
	const isSpoken = localTime >= end;
	const progress = Math.max(
		0,
		Math.min(1, (localTime - start) / Math.max(0.001, end - start)),
	);
	const isPresetDriven = revealMode === "determined-by-preset";
	const effectiveRevealMode = isPresetDriven ? preset.revealMode : revealMode;
	const isVisible =
		effectiveRevealMode === "row" ||
		isActive ||
		((effectiveRevealMode === "growing-row" ||
			effectiveRevealMode === "letter-by-letter" ||
			effectiveRevealMode === "spoken-word-keep" ||
			effectiveRevealMode === "emphasize-spoken-keep") &&
			(isSpoken || isActive)) ||
		(effectiveRevealMode === "emphasize-spoken" && !isActive);

	const presetStyle = isActive
		? preset.activeStyle
		: isSpoken && preset.spokenStyle
			? preset.spokenStyle
			: preset.idleStyle;
	const animationStyle = isPresetDriven
		? presetStyle
		: stripPresetRevealStyle({ style: presetStyle });
	const revealStyle = isPresetDriven
		? {}
		: resolveRevealStyle({
				revealMode: effectiveRevealMode,
				transitionIn,
				isActive,
				isSpoken,
				isVisible,
				progress,
			});
	const color =
		isActive && preset.useAccentOnActive
			? (accentColor ?? presetStyle.color ?? baseColor)
			: isSpoken && preset.useAccentOnSpoken
				? (accentColor ?? presetStyle.color ?? baseColor)
				: presetStyle.color;
	const wordStyle = run.style;
	const animationScale = isPresetDriven
		? (animationStyle.scale ?? 1)
		: (revealStyle.scale ?? animationStyle.scale ?? 1);
	const scopedScale = (rowStyle?.scale ?? 1) * (wordStyle?.scale ?? 1);
	const scopedScaleX =
		(rowStyle?.scaleX ?? rowStyle?.scale ?? 1) *
		(wordStyle?.scaleX ?? wordStyle?.scale ?? 1);
	const scopedScaleY =
		(rowStyle?.scaleY ?? rowStyle?.scale ?? 1) *
		(wordStyle?.scaleY ?? wordStyle?.scale ?? 1);
	const animationOpacity = isPresetDriven
		? (animationStyle.opacity ?? 1)
		: (revealStyle.opacity ?? 1);
	const scopedOpacity = wordStyle?.opacity ?? rowStyle?.opacity ?? 1;
	const animationOffsetX = isPresetDriven
		? (animationStyle.offsetX ?? 0)
		: (revealStyle.offsetX ?? animationStyle.offsetX ?? 0);
	const animationOffsetY = isPresetDriven
		? (animationStyle.offsetY ?? 0)
		: (revealStyle.offsetY ?? animationStyle.offsetY ?? 0);
	const animationBlur = isPresetDriven
		? (animationStyle.blur ?? 0)
		: (revealStyle.blur ?? animationStyle.blur ?? 0);
	const animationShadowBlur = isPresetDriven
		? (animationStyle.shadowBlur ?? 0)
		: (revealStyle.shadowBlur ?? animationStyle.shadowBlur ?? 0);
	const scopedShadowBlur = wordStyle?.shadowBlur ?? rowStyle?.shadowBlur;
	const scopedStrokeWidth = wordStyle?.strokeWidth ?? rowStyle?.strokeWidth;
	const finalStyle = {
		...base,
		...animationStyle,
		...rowStyle,
		...wordStyle,
		...revealStyle,
	};

	return {
		...finalStyle,
		color:
			wordStyle?.color ?? rowStyle?.color ?? color ?? baseColor ?? "#ffffff",
		shadowColor:
			wordStyle?.shadowColor ??
			rowStyle?.shadowColor ??
			((base.shadowBlur ?? 0) > 0 ||
			(base.shadowOffsetX ?? 0) !== 0 ||
			(base.shadowOffsetY ?? 0) !== 0
				? base.shadowColor
				: undefined) ??
			((presetStyle.shadowBlur ?? 0) > 0
				? (accentColor ?? color ?? baseColor ?? "#ffffff")
				: presetStyle.shadowColor),
		opacity: animationOpacity * scopedOpacity,
		scale: animationScale * scopedScale,
		scaleX: animationScale * scopedScaleX,
		scaleY: animationScale * scopedScaleY,
		offsetX:
			animationOffsetX + (rowStyle?.offsetX ?? 0) + (wordStyle?.offsetX ?? 0),
		offsetY:
			animationOffsetY + (rowStyle?.offsetY ?? 0) + (wordStyle?.offsetY ?? 0),
		blur: Math.max(animationBlur, rowStyle?.blur ?? 0, wordStyle?.blur ?? 0),
		shadowBlur:
			scopedShadowBlur ?? Math.max(base.shadowBlur ?? 0, animationShadowBlur),
		shadowOffsetX:
			wordStyle?.shadowOffsetX ??
			rowStyle?.shadowOffsetX ??
			base.shadowOffsetX ??
			0,
		shadowOffsetY:
			wordStyle?.shadowOffsetY ??
			rowStyle?.shadowOffsetY ??
			base.shadowOffsetY ??
			0,
		strokeWidth: scopedStrokeWidth ?? base.strokeWidth ?? 0,
		strokeColor:
			wordStyle?.strokeColor ?? rowStyle?.strokeColor ?? base.strokeColor,
	};
}

function stripPresetRevealStyle({
	style,
}: {
	style: TextWordStyle;
}): TextWordStyle {
	const visualStyle = { ...style };
	delete visualStyle.characterReveal;
	delete visualStyle.opacity;
	return visualStyle;
}

function resolveRevealMode({
	elementMode,
	presetMode,
}: {
	elementMode: TextElement["captionRevealMode"];
	presetMode: TextCaptionRevealMode;
}): TextCaptionRevealMode {
	return elementMode ?? presetMode;
}

function resolveRevealStyle({
	revealMode,
	transitionIn,
	isActive,
	isSpoken,
	isVisible,
	progress,
}: {
	revealMode: TextCaptionRevealMode;
	transitionIn: TextWordTransitionIn;
	isActive: boolean;
	isSpoken: boolean;
	isVisible: boolean;
	progress: number;
}): TextWordStyle {
	if (!isVisible) {
		return { opacity: 0 };
	}

	const activeEntrance = isActive
		? resolveTransitionInStyle({ transitionIn, progress })
		: {};

	if (revealMode === "row") {
		return { opacity: 1 };
	}

	if (revealMode === "spoken-word" || revealMode === "spoken-word-keep") {
		return isActive
			? { opacity: 1, ...activeEntrance }
			: { opacity: isSpoken ? 1 : 0 };
	}

	if (revealMode === "growing-row") {
		return isActive
			? { opacity: 1, ...activeEntrance }
			: { opacity: isSpoken ? 1 : 0 };
	}

	if (revealMode === "letter-by-letter") {
		return isActive
			? { opacity: 1, characterReveal: true }
			: { opacity: isSpoken ? 1 : 0 };
	}

	if (
		revealMode === "emphasize-spoken" ||
		revealMode === "emphasize-spoken-keep"
	) {
		if (isActive) {
			return { opacity: 1, scale: 1.18, fontWeight: "bold", ...activeEntrance };
		}
		return {
			opacity: revealMode === "emphasize-spoken-keep" && isSpoken ? 1 : 0.58,
			scale: revealMode === "emphasize-spoken-keep" && isSpoken ? 1.06 : 1,
		};
	}

	return {};
}

function resolveTransitionInStyle({
	transitionIn,
	progress,
}: {
	transitionIn: TextWordTransitionIn;
	progress: number;
}): TextWordStyle {
	const eased = 1 - Math.pow(1 - progress, 3);
	switch (transitionIn) {
		case "none":
			return {};
		case "fade":
			return { opacity: eased };
		case "blur":
			return { opacity: eased, blur: (1 - eased) * 12 };
		case "zoom":
			return { opacity: eased, scale: 0.72 + eased * 0.28 };
		case "blur-zoom":
			return {
				opacity: eased,
				blur: (1 - eased) * 14,
				scale: 0.72 + eased * 0.28,
			};
		case "rise":
			return { opacity: eased, offsetY: (1 - eased) * 20 };
		case "slide":
			return {
				opacity: eased,
				offsetX: (1 - eased) * -28,
				blur: (1 - eased) * 6,
			};
		case "typewriter":
			return { opacity: 1, characterReveal: true };
		case "glow-dissolve":
			return {
				opacity: eased,
				blur: (1 - eased) * 18,
				scale: 1.28 - eased * 0.28,
				shadowBlur: 28 * eased,
			};
	}
}

function resolveDrawText({
	run,
	style,
	localTime,
}: {
	run: TextWordRun;
	style: TextWordStyle & TextLayoutParams;
	localTime: number;
}) {
	if (!style.characterReveal) {
		return run.text;
	}
	const start = run.startTime ?? 0;
	const end = run.endTime ?? start;
	if (localTime <= start) {
		return "";
	}
	if (localTime >= end) {
		return run.text;
	}
	const progress = Math.max(
		0,
		Math.min(1, (localTime - start) / Math.max(0.001, end - start)),
	);
	const characters = Array.from(run.text);
	const visibleCount = Math.max(1, Math.ceil(characters.length * progress));
	return characters.slice(0, visibleCount).join("");
}

const STRONG_RTL_CHARACTER_REGEX =
	/[\u0590-\u05ff\u0600-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u{10800}-\u{10fff}\u{1e800}-\u{1e95f}]/u;
const LETTER_CHARACTER_REGEX = /\p{Letter}/u;

export function resolveAutoTextDirection(text: string): CanvasDirection {
	for (const character of text) {
		if (
			STRONG_RTL_CHARACTER_REGEX.test(character) &&
			LETTER_CHARACTER_REGEX.test(character)
		) {
			return "rtl";
		}
		if (LETTER_CHARACTER_REGEX.test(character)) {
			return "ltr";
		}
	}
	return "ltr";
}

function resolveWordDirection({
	element,
	override,
	text,
}: {
	element: TextElement;
	override?: TextElement["captionWordDirection"];
	text?: string;
}): CanvasDirection {
	if (override === "ltr" || override === "rtl") {
		return override;
	}
	if (override === "auto") {
		return resolveAutoTextDirection(text ?? getElementText(element));
	}
	if (
		element.captionWordDirection === "ltr" ||
		element.captionWordDirection === "rtl"
	) {
		return element.captionWordDirection;
	}
	return resolveAutoTextDirection(text ?? getElementText(element));
}

function getElementText(element: TextElement): string {
	return (
		element.wordRuns?.map((word) => word.text).join(" ") ??
		(typeof element.params.content === "string" ? element.params.content : "")
	);
}

function getRowOverride({
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

function resolveWordAnimationId({
	element,
	rowOverride,
	run,
}: {
	element: TextElement;
	rowOverride: TextRowOverride | undefined;
	run: TextWordRun;
}) {
	const legacyElement = element as TextElement & { captionPresetId?: string };
	return (
		run.wordAnimationId ??
		rowOverride?.wordAnimationId ??
		element.captionWordAnimationId ??
		legacyElement.captionPresetId
	);
}

function measureStyledWord({
	ctx,
	text,
	style,
	canvasHeight,
}: {
	ctx: TextLayoutMeasurementContext;
	text: string;
	style: TextWordStyle & TextLayoutParams;
	canvasHeight: number;
}): {
	metrics: TextMetrics;
	fontString: string;
	scaledFontSize: number;
} {
	const scaledFontSize =
		(style.fontSize ?? 15) * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	const fontString = buildTextFontString({
		fontFamily: style.fontFamily ?? "Arial",
		fontWeight: normalizeTextFontWeight({
			value: style.fontWeight,
			fallback: "normal",
		}),
		fontStyle: style.fontStyle === "italic" ? "italic" : "normal",
		scaledFontSize,
	});
	ctx.save();
	ctx.font = fontString;
	ctx.textBaseline = "middle";
	if ("letterSpacing" in ctx) {
		ctx.letterSpacing = `${style.letterSpacing ?? DEFAULTS.text.letterSpacing}px`;
	}
	const metrics = ctx.measureText(text);
	ctx.restore();
	return { metrics, fontString, scaledFontSize };
}

export function buildTextLayoutParamsFromElement({
	element,
}: {
	element: TextElement;
}): TextLayoutParams {
	return {
		content: readStringParam({
			params: element.params,
			key: "content",
			fallback: "Default text",
		}),
		fontSize: readNumberParam({
			params: element.params,
			key: "fontSize",
			fallback: 15,
		}),
		fontFamily: readStringParam({
			params: element.params,
			key: "fontFamily",
			fallback: "Arial",
		}),
		fontWeight: readFontWeight({
			value: element.params.fontWeight,
			fallback: "normal",
		}),
		fontStyle: readFontStyle({
			value: element.params.fontStyle,
			fallback: "normal",
		}),
		textAlign: readTextAlign({
			value: element.params.textAlign,
			fallback: "center",
		}),
		textDecoration: readTextDecoration({
			value: element.params.textDecoration,
			fallback: "none",
		}),
		letterSpacing: readNumberParam({
			params: element.params,
			key: "letterSpacing",
			fallback: DEFAULTS.text.letterSpacing,
		}),
		lineHeight: readNumberParam({
			params: element.params,
			key: "lineHeight",
			fallback: DEFAULTS.text.lineHeight,
		}),
		strokeWidth: readBooleanParam({
			params: element.params,
			key: "stroke.enabled",
			fallback: DEFAULTS.text.stroke.enabled,
		})
			? readNumberParam({
					params: element.params,
					key: "stroke.width",
					fallback: DEFAULTS.text.stroke.width,
				})
			: 0,
		strokeColor: readStringParam({
			params: element.params,
			key: "stroke.color",
			fallback: DEFAULTS.text.stroke.color,
		}),
		shadowBlur: readBooleanParam({
			params: element.params,
			key: "shadow.enabled",
			fallback: DEFAULTS.text.shadow.enabled,
		})
			? readNumberParam({
					params: element.params,
					key: "shadow.blur",
					fallback: DEFAULTS.text.shadow.blur,
				})
			: 0,
		shadowColor: readStringParam({
			params: element.params,
			key: "shadow.color",
			fallback: DEFAULTS.text.shadow.color,
		}),
		shadowOffsetX: readBooleanParam({
			params: element.params,
			key: "shadow.enabled",
			fallback: DEFAULTS.text.shadow.enabled,
		})
			? readNumberParam({
					params: element.params,
					key: "shadow.offsetX",
					fallback: DEFAULTS.text.shadow.offsetX,
				})
			: 0,
		shadowOffsetY: readBooleanParam({
			params: element.params,
			key: "shadow.enabled",
			fallback: DEFAULTS.text.shadow.enabled,
		})
			? readNumberParam({
					params: element.params,
					key: "shadow.offsetY",
					fallback: DEFAULTS.text.shadow.offsetY,
				})
			: 0,
	};
}

export function buildTextBackgroundFromElement({
	element,
}: {
	element: TextElement;
}): TextBackground {
	return {
		enabled: readBooleanParam({
			params: element.params,
			key: "background.enabled",
			fallback: DEFAULTS.text.background.enabled,
		}),
		color: readStringParam({
			params: element.params,
			key: "background.color",
			fallback: DEFAULTS.text.background.color,
		}),
		cornerRadius: readNumberParam({
			params: element.params,
			key: "background.cornerRadius",
			fallback: DEFAULTS.text.background.cornerRadius,
		}),
		paddingX: readNumberParam({
			params: element.params,
			key: "background.paddingX",
			fallback: DEFAULTS.text.background.paddingX,
		}),
		paddingY: readNumberParam({
			params: element.params,
			key: "background.paddingY",
			fallback: DEFAULTS.text.background.paddingY,
		}),
		offsetX: readNumberParam({
			params: element.params,
			key: "background.offsetX",
			fallback: DEFAULTS.text.background.offsetX,
		}),
		offsetY: readNumberParam({
			params: element.params,
			key: "background.offsetY",
			fallback: DEFAULTS.text.background.offsetY,
		}),
	};
}

function readStringParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: string;
}): string {
	const value = params[key];
	return typeof value === "string" ? value : fallback;
}

function readNumberParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" ? value : fallback;
}

function readBooleanParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: boolean;
}): boolean {
	const value = params[key];
	return typeof value === "boolean" ? value : fallback;
}

function readTextAlign({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextAlign;
}): TextAlign {
	return value === "left" || value === "center" || value === "right"
		? value
		: fallback;
}

function readFontWeight({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextFontWeight;
}): TextFontWeight {
	return normalizeTextFontWeight({ value, fallback });
}

function readFontStyle({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextFontStyle;
}): TextFontStyle {
	return value === "italic" || value === "normal" ? value : fallback;
}

function readTextDecoration({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextDecoration;
}): TextDecoration {
	return value === "none" || value === "underline" || value === "line-through"
		? value
		: fallback;
}
