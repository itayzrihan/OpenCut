import type {
	TextBlockMeasurement,
	TextCanvasContext,
	TextLayoutMeasurementContext,
} from "@/text/layout";
import type { BlendMode } from "@/rendering";
import { DEFAULTS } from "@/timeline/defaults";
import { clamp } from "@/utils/math";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "./background";
import {
	drawTextDecoration,
	getTextBackgroundRect,
	measureTextBlock,
	setCanvasLetterSpacing,
} from "./layout";
import { FONT_SIZE_SCALE_REFERENCE } from "./typography";

export type TextAlign = "left" | "center" | "right";
export type NumericTextFontWeight =
	| "100"
	| "200"
	| "300"
	| "400"
	| "500"
	| "600"
	| "700"
	| "800"
	| "900";
export type TextFontWeight = "normal" | "bold" | NumericTextFontWeight;
export type TextFontStyle = "normal" | "italic";
export type TextDecoration = "none" | "underline" | "line-through";

export interface TextGradient {
	startColor: string;
	endColor: string;
	angle: number;
}

const NUMERIC_TEXT_FONT_WEIGHTS = new Set<string>([
	"100",
	"200",
	"300",
	"400",
	"500",
	"600",
	"700",
	"800",
	"900",
]);

export interface TextLayoutParams {
	content: string;
	fontSize: number;
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	textAlign: TextAlign;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
	gradient?: TextGradient;
	bottomFadeOut?: number;
	bottomFadeOutEndOpacity?: number;
	strokeWidth?: number;
	strokeColor?: string;
	shadowBlur?: number;
	shadowColor?: string;
	shadowOffsetX?: number;
	shadowOffsetY?: number;
	windowShadow?: boolean;
}

export interface ResolvedTextStroke {
	color: string;
	width: number;
}

export interface ResolvedTextShadow {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
}

export interface ResolvedTextLayout {
	scaledFontSize: number;
	fontString: string;
	letterSpacing: number;
	lineHeightPx: number;
	fontSizeRatio: number;
	textAlign: TextAlign;
	textDecoration: TextDecoration;
	gradient?: TextGradient;
	bottomFadeOut: number;
	bottomFadeOutEndOpacity: number;
	windowShadow: boolean;
}

export interface MeasuredTextLayout extends ResolvedTextLayout {
	lines: string[];
	lineMetrics: TextMetrics[];
	block: TextBlockMeasurement;
	wordLines?: MeasuredWordLine[];
	stroke?: ResolvedTextStroke | null;
	shadow?: ResolvedTextShadow | null;
}

export interface MeasuredWordGlyph {
	id: string;
	text: string;
	drawText: string;
	x: number;
	y: number;
	width: number;
	layoutWidth: number;
	metrics: TextMetrics;
	fontString: string;
	scaledFontSize: number;
	letterSpacing: number;
	color: string;
	opacity: number;
	scale: number;
	scaleX: number;
	scaleY: number;
	rotate: number;
	blur: number;
	shadowBlur: number;
	shadowColor: string;
	shadowOffsetX: number;
	shadowOffsetY: number;
	windowShadow: boolean;
	strokeWidth: number;
	strokeColor: string;
	offsetX: number;
	offsetY: number;
	blendMode: BlendMode;
	bottomFadeOut: number;
	bottomFadeOutEndOpacity: number;
	background?: {
		enabled: boolean;
		color: string;
		paddingX: number;
		paddingY: number;
		offsetX: number;
		offsetY: number;
		cornerRadius: number;
	};
	direction: CanvasDirection;
	textDecoration: TextDecoration;
	glowerProgress: number;
	glowerDirection: CanvasDirection;
	lightningProgress: number;
	glitchyProgress: number;
	lightningActive: boolean;
	glitchyActive: boolean;
	gradient?: TextGradient;
}

export interface MeasuredWordLine {
	y: number;
	width: number;
	words: MeasuredWordGlyph[];
}

export interface ResolvedTextBackgroundLike {
	enabled: boolean;
	color: string;
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export function quoteFontFamily({
	fontFamily,
}: {
	fontFamily: string;
}): string {
	return `"${fontFamily.replace(/"/g, '\\"')}"`;
}

export function buildTextFontString({
	fontFamily,
	fontWeight,
	fontStyle,
	scaledFontSize,
}: {
	fontFamily: string;
	fontWeight: TextFontWeight;
	fontStyle: TextFontStyle;
	scaledFontSize: number;
}): string {
	return `${fontStyle} ${fontWeight} ${scaledFontSize}px ${quoteFontFamily({ fontFamily })}, sans-serif`;
}

export function normalizeTextFontWeight({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextFontWeight;
}): TextFontWeight {
	if (typeof value !== "string") return fallback;

	const normalized = value.trim().toLowerCase();
	if (normalized === "normal" || normalized === "bold") return normalized;
	if (NUMERIC_TEXT_FONT_WEIGHTS.has(normalized)) {
		return normalized as NumericTextFontWeight;
	}
	return fallback;
}

export function resolveTextLayout({
	text,
	canvasHeight,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
}): ResolvedTextLayout {
	const scaledFontSize =
		text.fontSize * (canvasHeight / FONT_SIZE_SCALE_REFERENCE);
	const fontWeight = normalizeTextFontWeight({
		value: text.fontWeight,
		fallback: "normal",
	});
	const fontStyle = text.fontStyle === "italic" ? "italic" : "normal";
	const letterSpacing = text.letterSpacing ?? DEFAULTS.text.letterSpacing;
	const lineHeightPx =
		scaledFontSize * (text.lineHeight ?? DEFAULTS.text.lineHeight);
	const fontSizeRatio = text.fontSize / 15;

	return {
		scaledFontSize,
		fontString: buildTextFontString({
			fontFamily: text.fontFamily,
			fontWeight,
			fontStyle,
			scaledFontSize,
		}),
		letterSpacing,
		lineHeightPx,
		fontSizeRatio,
		textAlign: text.textAlign,
		textDecoration: text.textDecoration ?? "none",
		gradient: text.gradient,
		bottomFadeOut: clampBottomFadeOut(text.bottomFadeOut),
		bottomFadeOutEndOpacity: clampBottomFadeOutEndOpacity(
			text.bottomFadeOutEndOpacity,
		),
		windowShadow: text.windowShadow ?? false,
	};
}

export function measureTextLayout({
	text,
	canvasHeight,
	ctx,
}: {
	text: TextLayoutParams;
	canvasHeight: number;
	ctx: TextLayoutMeasurementContext;
}): MeasuredTextLayout {
	const resolvedLayout = resolveTextLayout({ text, canvasHeight });
	const lines = text.content.split("\n");

	ctx.save();
	ctx.font = resolvedLayout.fontString;
	ctx.textBaseline = "middle";
	setCanvasLetterSpacing({
		ctx,
		letterSpacingPx: resolvedLayout.letterSpacing,
	});
	const lineMetrics = lines.map((line) => ctx.measureText(line));
	ctx.restore();

	const block = measureTextBlock({
		lineMetrics,
		lineHeightPx: resolvedLayout.lineHeightPx,
	});

	return {
		...resolvedLayout,
		lines,
		lineMetrics,
		block,
	};
}

export function drawMeasuredTextLayout({
	ctx,
	layout,
	textColor,
	background,
	backgroundColor,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	background?: ResolvedTextBackgroundLike | null;
	backgroundColor?: string;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.fillStyle = createTextFill({ ctx, layout, fallbackColor: textColor });
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	if (
		background?.enabled &&
		backgroundColor &&
		backgroundColor !== "transparent" &&
		layout.lines.length > 0
	) {
		const backgroundRect = getTextBackgroundRect({
			textAlign: layout.textAlign,
			block: layout.block,
			background: {
				...background,
				color: backgroundColor,
			},
			fontSizeRatio: layout.fontSizeRatio,
		});
		if (backgroundRect) {
			const p =
				clamp({
					value: background.cornerRadius,
					min: CORNER_RADIUS_MIN,
					max: CORNER_RADIUS_MAX,
				}) / 100;
			const radius =
				(Math.min(backgroundRect.width, backgroundRect.height) / 2) * p;
			ctx.fillStyle = backgroundColor;
			ctx.beginPath();
			ctx.roundRect(
				backgroundRect.left,
				backgroundRect.top,
				backgroundRect.width,
				backgroundRect.height,
				radius,
			);
			ctx.fill();
			ctx.fillStyle = createTextFill({ ctx, layout, fallbackColor: textColor });
		}
	}

	if (layout.wordLines) {
		for (const line of layout.wordLines) {
			for (const word of line.words) {
				if (word.opacity <= 0) continue;
				const drawTextAlign: CanvasTextAlign =
					word.direction === "rtl" ? "right" : "left";
				const drawTextX = word.direction === "rtl" ? word.width : 0;
				ctx.save();
				ctx.font = word.fontString;
				ctx.textAlign = drawTextAlign;
				ctx.textBaseline = textBaseline;
				ctx.direction = word.direction;
				ctx.fillStyle = createWordFill({ ctx, word });
				ctx.globalCompositeOperation = toCanvasCompositeOperation(
					word.blendMode,
				);
				ctx.globalAlpha *= word.opacity;
				if (word.blur > 0) {
					ctx.filter = `blur(${word.blur}px)`;
				}
				setCanvasLetterSpacing({ ctx, letterSpacingPx: word.letterSpacing });
				const x = word.x + word.offsetX + word.layoutWidth / 2;
				const y = word.y + word.offsetY;
				ctx.translate(x, y);
				if (word.rotate) {
					ctx.rotate((word.rotate * Math.PI) / 180);
				}
				ctx.scale(word.scaleX, word.scaleY);
				ctx.translate(-word.width / 2, 0);
				drawWordBackground({ ctx, word });
				if (
					word.bottomFadeOut > 0 &&
					drawWordTextWithBottomFadeOut({
						ctx,
						word,
						drawTextAlign,
						drawTextX,
						textBaseline,
					})
				) {
					ctx.restore();
					continue;
				}
				drawWordText({
					ctx,
					word,
					drawTextAlign,
					drawTextX,
					textBaseline,
				});
				ctx.restore();
			}
		}
		return;
	}

	if (
		layout.bottomFadeOut > 0 &&
		drawPlainTextWithBottomFadeOut({
			ctx,
			layout,
			textColor,
			textBaseline,
		})
	) {
		return;
	}
	drawPlainText({ ctx, layout });
}

function drawWordText({
	ctx,
	word,
	drawTextAlign,
	drawTextX,
	textBaseline,
	shadow = {
		color: word.shadowColor,
		blur: word.shadowBlur,
		offsetX: word.shadowOffsetX,
		offsetY: word.shadowOffsetY,
	},
}: {
	ctx: TextCanvasContext;
	word: MeasuredWordGlyph;
	drawTextAlign: CanvasTextAlign;
	drawTextX: number;
	textBaseline: CanvasTextBaseline;
	shadow?: ResolvedTextShadow | null;
}): void {
	ctx.save();
	ctx.font = word.fontString;
	ctx.textAlign = drawTextAlign;
	ctx.textBaseline = textBaseline;
	ctx.direction = word.direction;
	ctx.fillStyle = createWordFill({ ctx, word });
	setCanvasLetterSpacing({ ctx, letterSpacingPx: word.letterSpacing });
	ctx.translate(drawTextX, 0);
	applyTextShadow({ ctx, shadow });
	if (word.strokeWidth > 0) {
		ctx.strokeStyle = word.strokeColor;
		ctx.lineWidth = word.strokeWidth;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		ctx.strokeText(word.drawText, 0, 0);
	}
	ctx.fillText(word.drawText, 0, 0);
	drawGlower({ ctx, word });
	drawLightningStorm({ ctx, word });
	drawGlitchy({ ctx, word });
	drawTextDecoration({
		ctx,
		textDecoration: word.textDecoration,
		lineWidth: word.width,
		lineY: 0,
		metrics: word.metrics,
		scaledFontSize: word.scaledFontSize,
		textAlign: drawTextAlign,
	});
	ctx.restore();
}

function drawPlainText({
	ctx,
	layout,
	shadow = layout.shadow,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	shadow?: ResolvedTextShadow | null;
}): void {
	applyTextShadow({ ctx, shadow });
	if (layout.stroke && layout.stroke.width > 0) {
		ctx.strokeStyle = layout.stroke.color;
		ctx.lineWidth = layout.stroke.width;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";
		for (let index = 0; index < layout.lines.length; index++) {
			const lineY =
				index * layout.lineHeightPx - layout.block.visualCenterOffset;
			ctx.strokeText(layout.lines[index], 0, lineY);
		}
	}

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.fillText(layout.lines[index], 0, lineY);
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[index].width,
			lineY,
			metrics: layout.lineMetrics[index],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	}
}

function drawWordTextWithBottomFadeOut({
	ctx,
	word,
	drawTextAlign,
	drawTextX,
	textBaseline,
}: {
	ctx: TextCanvasContext;
	word: MeasuredWordGlyph;
	drawTextAlign: CanvasTextAlign;
	drawTextX: number;
	textBaseline: CanvasTextBaseline;
}): boolean {
	const ascent =
		word.metrics.actualBoundingBoxAscent || word.scaledFontSize * 0.8;
	const descent =
		word.metrics.actualBoundingBoxDescent || word.scaledFontSize * 0.2;
	const effectOutset = Math.ceil(
		Math.max(
			4,
			word.strokeWidth * 2,
			word.shadowBlur * 2 + Math.abs(word.shadowOffsetX),
			word.shadowBlur * 2 + Math.abs(word.shadowOffsetY),
			word.glowerProgress > 0 || word.lightningActive || word.glitchyActive
				? word.scaledFontSize * 1.5
				: 0,
		),
	);
	const width = Math.max(1, Math.ceil(word.width + effectOutset * 2));
	const height = Math.max(1, Math.ceil(ascent + descent + effectOutset * 2));
	const surface = createTextEffectSurface({ width, height });
	if (!surface) return false;

	surface.ctx.translate(effectOutset, effectOutset + ascent);
	drawWordText({
		ctx: surface.ctx,
		word,
		drawTextAlign,
		drawTextX,
		textBaseline,
	});
	surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
	if (word.windowShadow) {
		// Window Shadow intentionally removes the shadow from the glyph bounds,
		// leaving it visible only around the outside edge of the text window.
		surface.ctx.clearRect(0, effectOutset, width, ascent + descent);
	} else {
		const maskSurface = createTextEffectSurface({ width, height });
		if (!maskSurface) return false;
		maskSurface.ctx.translate(effectOutset, effectOutset + ascent);
		drawWordText({
			ctx: maskSurface.ctx,
			word,
			drawTextAlign,
			drawTextX,
			textBaseline,
			shadow: null,
		});
		maskSurface.ctx.setTransform(1, 0, 0, 1, 0, 0);
		surface.ctx.globalCompositeOperation = "destination-out";
		surface.ctx.drawImage(maskSurface.canvas, 0, 0);
		surface.ctx.globalCompositeOperation = "source-over";
	}
	ctx.drawImage(surface.canvas, -effectOutset, -ascent - effectOutset);

	surface.ctx.clearRect(0, 0, width, height);
	surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
	surface.ctx.translate(effectOutset, effectOutset + ascent);
	drawWordText({
		ctx: surface.ctx,
		word,
		drawTextAlign,
		drawTextX,
		textBaseline,
		shadow: null,
	});
	surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
	applyBottomFadeOutMask({
		ctx: surface.ctx,
		width,
		height,
		top: effectOutset,
		bottom: effectOutset + ascent + descent,
		strength: word.bottomFadeOut,
		endOpacity: word.bottomFadeOutEndOpacity,
	});
	ctx.drawImage(surface.canvas, -effectOutset, -ascent - effectOutset);
	return true;
}

function drawPlainTextWithBottomFadeOut({
	ctx,
	layout,
	textColor,
	textBaseline,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	textColor: string;
	textBaseline: CanvasTextBaseline;
}): boolean {
	const verticalBounds = getPlainTextVerticalBounds({ layout });
	const effectOutset = Math.ceil(
		Math.max(
			4,
			(layout.stroke?.width ?? 0) * 2,
			(layout.shadow?.blur ?? 0) * 2 + Math.abs(layout.shadow?.offsetX ?? 0),
			(layout.shadow?.blur ?? 0) * 2 + Math.abs(layout.shadow?.offsetY ?? 0),
		),
	);
	const left =
		layout.textAlign === "center"
			? -layout.block.maxWidth / 2
			: layout.textAlign === "right"
				? -layout.block.maxWidth
				: 0;
	const top = verticalBounds.top;
	const width = Math.max(
		1,
		Math.ceil(layout.block.maxWidth + effectOutset * 2),
	);
	const height = Math.max(
		1,
		Math.ceil(verticalBounds.bottom - top + effectOutset * 2),
	);
	const surface = createTextEffectSurface({ width, height });
	if (!surface) return false;

	surface.ctx.translate(effectOutset - left, effectOutset - top);
	surface.ctx.font = layout.fontString;
	surface.ctx.textAlign = layout.textAlign;
	surface.ctx.textBaseline = textBaseline;
	surface.ctx.fillStyle = createTextFill({
		ctx: surface.ctx,
		layout,
		fallbackColor: textColor,
	});
	setCanvasLetterSpacing({
		ctx: surface.ctx,
		letterSpacingPx: layout.letterSpacing,
	});
	drawPlainText({ ctx: surface.ctx, layout });
	surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
	if (layout.windowShadow) {
		// Window Shadow intentionally removes the shadow from the glyph bounds,
		// leaving it visible only around the outside edge of the text window.
		surface.ctx.clearRect(0, effectOutset, width, verticalBounds.bottom - top);
	} else {
		const maskSurface = createTextEffectSurface({ width, height });
		if (!maskSurface) return false;
		maskSurface.ctx.translate(effectOutset - left, effectOutset - top);
		maskSurface.ctx.font = layout.fontString;
		maskSurface.ctx.textAlign = layout.textAlign;
		maskSurface.ctx.textBaseline = textBaseline;
		maskSurface.ctx.fillStyle = createTextFill({
			ctx: maskSurface.ctx,
			layout,
			fallbackColor: textColor,
		});
		setCanvasLetterSpacing({
			ctx: maskSurface.ctx,
			letterSpacingPx: layout.letterSpacing,
		});
		drawPlainText({ ctx: maskSurface.ctx, layout, shadow: null });
		maskSurface.ctx.setTransform(1, 0, 0, 1, 0, 0);
		surface.ctx.globalCompositeOperation = "destination-out";
		surface.ctx.drawImage(maskSurface.canvas, 0, 0);
		surface.ctx.globalCompositeOperation = "source-over";
	}
	ctx.drawImage(surface.canvas, left - effectOutset, top - effectOutset);

	surface.ctx.clearRect(0, 0, width, height);
	surface.ctx.translate(effectOutset - left, effectOutset - top);
	surface.ctx.font = layout.fontString;
	surface.ctx.textAlign = layout.textAlign;
	surface.ctx.textBaseline = textBaseline;
	surface.ctx.fillStyle = createTextFill({
		ctx: surface.ctx,
		layout,
		fallbackColor: textColor,
	});
	setCanvasLetterSpacing({
		ctx: surface.ctx,
		letterSpacingPx: layout.letterSpacing,
	});
	drawPlainText({ ctx: surface.ctx, layout, shadow: null });
	surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
	applyBottomFadeOutMask({
		ctx: surface.ctx,
		width,
		height,
		top: effectOutset,
		bottom: effectOutset + verticalBounds.bottom - top,
		strength: layout.bottomFadeOut,
		endOpacity: layout.bottomFadeOutEndOpacity,
	});
	ctx.drawImage(surface.canvas, left - effectOutset, top - effectOutset);
	return true;
}

function getPlainTextVerticalBounds({
	layout,
}: {
	layout: MeasuredTextLayout;
}): { top: number; bottom: number } {
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < layout.lineMetrics.length; index++) {
		const metrics = layout.lineMetrics[index];
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		const ascent =
			metrics.actualBoundingBoxAscent || layout.scaledFontSize * 0.8;
		const descent =
			metrics.actualBoundingBoxDescent || layout.scaledFontSize * 0.2;
		top = Math.min(top, lineY - ascent);
		bottom = Math.max(bottom, lineY + descent);
	}
	if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
		return {
			top: -layout.scaledFontSize * 0.8,
			bottom: layout.scaledFontSize * 0.2,
		};
	}
	return { top, bottom };
}

function applyBottomFadeOutMask({
	ctx,
	width,
	height,
	top,
	bottom,
	strength,
	endOpacity,
}: {
	ctx: TextCanvasContext;
	width: number;
	height: number;
	top: number;
	bottom: number;
	strength: number;
	endOpacity: number;
}): void {
	const range = getBottomFadeOutRange({ top, bottom, strength });
	const mask = ctx.createLinearGradient(0, range.start, 0, range.end);
	mask.addColorStop(0, "rgba(255,255,255,1)");
	mask.addColorStop(
		1,
		`rgba(255,255,255,${clampBottomFadeOutEndOpacity(endOpacity)})`,
	);
	ctx.globalCompositeOperation = "destination-in";
	ctx.fillStyle = mask;
	ctx.fillRect(0, 0, width, height);
	ctx.globalCompositeOperation = "source-over";
}

function createTextEffectSurface({
	width,
	height,
}: {
	width: number;
	height: number;
}): {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	ctx: TextCanvasContext;
} | null {
	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		return ctx ? { canvas, ctx } : null;
	}
	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		return ctx ? { canvas, ctx } : null;
	}
	return null;
}

export function clampBottomFadeOut(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

export function clampBottomFadeOutEndOpacity(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

export function getBottomFadeOutRange({
	top,
	bottom,
	strength,
}: {
	top: number;
	bottom: number;
	strength: number;
}): { start: number; end: number } {
	const clampedStrength = clampBottomFadeOut(strength);
	const height = Math.max(0, bottom - top);
	return {
		start: bottom - height * clampedStrength,
		end: bottom,
	};
}

function createWordFill({ ctx, word }: { ctx: TextCanvasContext; word: MeasuredWordGlyph }) {
	if (!word.gradient) return word.color;
	const radians = (word.gradient.angle * Math.PI) / 180;
	const dx = Math.cos(radians) * word.width * 0.5;
	const dy = Math.sin(radians) * word.scaledFontSize * 0.5;
	const gradient = ctx.createLinearGradient(word.width / 2 - dx, -dy, word.width / 2 + dx, dy);
	gradient.addColorStop(0, word.gradient.startColor);
	gradient.addColorStop(1, word.gradient.endColor);
	return gradient;
}

function createTextFill({
	ctx,
	layout,
	fallbackColor,
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	fallbackColor: string;
}): string | CanvasGradient {
	if (!layout.gradient) return fallbackColor;

	const left =
		layout.textAlign === "center"
			? -layout.block.maxWidth / 2
			: layout.textAlign === "right"
				? -layout.block.maxWidth
				: 0;
	const width = Math.max(1, layout.block.maxWidth);
	const bounds = getPlainTextVerticalBounds({ layout });
	const height = Math.max(1, bounds.bottom - bounds.top);
	const radians = (layout.gradient.angle * Math.PI) / 180;
	const directionX = Math.cos(radians);
	const directionY = Math.sin(radians);
	const halfLength =
		Math.abs(directionX) * (width / 2) + Math.abs(directionY) * (height / 2);
	const centerX = left + width / 2;
	const centerY = bounds.top + height / 2;
	const gradient = ctx.createLinearGradient(
		centerX - directionX * halfLength,
		centerY - directionY * halfLength,
		centerX + directionX * halfLength,
		centerY + directionY * halfLength,
	);
	gradient.addColorStop(0, layout.gradient.startColor);
	gradient.addColorStop(1, layout.gradient.endColor);
	return gradient;
}

function drawLightningStorm({ ctx, word }: { ctx: TextCanvasContext; word: MeasuredWordGlyph }) {
	if (!word.lightningActive) return;
	const edgePoints = getGlyphEdgePoints({ word });
	if (edgePoints.length === 0) return;
	ctx.save();
	ctx.globalCompositeOperation = "screen";
	ctx.strokeStyle = word.color;
	ctx.shadowColor = word.color;
	ctx.shadowBlur = Math.max(10, word.scaledFontSize * 0.45);
	ctx.lineWidth = Math.max(1, word.scaledFontSize * 0.025);
	ctx.globalAlpha *= 0.72;
	const centerX = word.glowerDirection === "rtl" ? -word.width / 2 : word.width / 2;
	const centerY =
		(word.metrics.actualBoundingBoxDescent - word.metrics.actualBoundingBoxAscent) / 2;
	const boltCount = Math.min(9, Math.max(4, Math.round(word.text.length * 1.5)));
	for (let bolt = 0; bolt < boltCount; bolt += 1) {
		const seed = hashString(`${word.id}:${bolt}`);
		const point = edgePoints[(seed + Math.floor(word.lightningProgress * 17)) % edgePoints.length];
		const dx = point.x - centerX;
		const dy = point.y - centerY;
		const length = Math.max(0.001, Math.hypot(dx, dy));
		const outwardX = dx / length;
		const outwardY = dy / length;
		ctx.beginPath();
		let x = point.x;
		let y = point.y;
		ctx.moveTo(x, y);
		for (let segment = 1; segment <= 5; segment += 1) {
			const jitter = Math.sin((segment + seed) * 2.17 + word.lightningProgress * 31) * 4;
			x += outwardX * word.scaledFontSize * 0.11 - outwardY * jitter;
			y += outwardY * word.scaledFontSize * 0.11 + outwardX * jitter;
			ctx.lineTo(x, y);
		}
		ctx.stroke();
	}
	ctx.restore();
}

function drawGlitchy({ ctx, word }: { ctx: TextCanvasContext; word: MeasuredWordGlyph }) {
	if (!word.glitchyActive) return;
	ctx.save();
	ctx.shadowBlur = 0;
	ctx.shadowOffsetX = 0;
	ctx.shadowOffsetY = 0;
	const top = -word.metrics.actualBoundingBoxAscent;
	const height = word.metrics.actualBoundingBoxAscent + word.metrics.actualBoundingBoxDescent;
	for (let slice = 0; slice < 7; slice += 1) {
		const sliceHeight = height / 7;
		const offset = Math.sin(slice * 12.7 + word.glitchyProgress * 43) * word.scaledFontSize * 0.09;
		ctx.save();
		ctx.beginPath();
		ctx.rect(-word.width - 8, top + slice * sliceHeight, word.width * 2 + 16, sliceHeight + 0.5);
		ctx.clip();
		ctx.globalCompositeOperation = "destination-out";
		ctx.fillText(word.drawText, 0, 0);
		ctx.globalCompositeOperation = "source-over";
		ctx.fillStyle = createWordFill({ ctx, word });
		ctx.fillText(word.drawText, offset, 0);
		ctx.restore();
	}
	ctx.restore();
}

const glyphEdgePointCache = new Map<string, Array<{ x: number; y: number }>>();

function getGlyphEdgePoints({ word }: { word: MeasuredWordGlyph }): Array<{ x: number; y: number }> {
	const cacheKey = `${word.fontString}:${word.direction}:${word.drawText}`;
	const cached = glyphEdgePointCache.get(cacheKey);
	if (cached) return cached;
	if (typeof OffscreenCanvas === "undefined") return [];
	const padding = 10;
	const width = Math.max(1, Math.ceil(word.width + padding * 2));
	const height = Math.max(
		1,
		Math.ceil(
			word.metrics.actualBoundingBoxAscent +
				word.metrics.actualBoundingBoxDescent +
				padding * 2,
		),
	);
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) return [];
	context.font = word.fontString;
	context.textBaseline = "alphabetic";
	context.textAlign = word.direction === "rtl" ? "right" : "left";
	context.direction = word.direction;
	context.fillStyle = "#fff";
	const originX = word.direction === "rtl" ? padding + word.width : padding;
	const baseline = padding + word.metrics.actualBoundingBoxAscent;
	context.fillText(word.drawText, originX, baseline);
	const pixels = context.getImageData(0, 0, width, height).data;
	const points: Array<{ x: number; y: number }> = [];
	const alphaAt = ({ x, y }: { x: number; y: number }) =>
		pixels[(y * width + x) * 4 + 3] ?? 0;
	for (let y = 1; y < height - 1; y += 2) {
		for (let x = 1; x < width - 1; x += 2) {
			if (alphaAt({ x, y }) < 80) continue;
			if (
				alphaAt({ x: x - 1, y }) < 40 ||
				alphaAt({ x: x + 1, y }) < 40 ||
				alphaAt({ x, y: y - 1 }) < 40 ||
				alphaAt({ x, y: y + 1 }) < 40
			) {
				points.push({ x: x - originX, y: y - baseline });
			}
		}
	}
	if (glyphEdgePointCache.size > 300) {
		glyphEdgePointCache.delete(glyphEdgePointCache.keys().next().value ?? "");
	}
	glyphEdgePointCache.set(cacheKey, points);
	return points;
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function drawGlower({
	ctx,
	word,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	word: MeasuredWordGlyph;
}) {
	const progress = Math.max(0, Math.min(1, word.glowerProgress));
	if (progress <= 0 || typeof OffscreenCanvas === "undefined") return;
	const blur = Math.max(8, word.scaledFontSize * 0.34);
	const padding = Math.ceil(blur * 2.5);
	const ascent = word.metrics.actualBoundingBoxAscent;
	const descent = word.metrics.actualBoundingBoxDescent;
	const width = Math.max(1, Math.ceil(word.width + padding * 2));
	const height = Math.max(1, Math.ceil(ascent + descent + padding * 2));
	const glowCanvas = new OffscreenCanvas(width, height);
	const glow = glowCanvas.getContext("2d");
	if (!glow) return;
	const originX = word.direction === "rtl" ? padding + word.width : padding;
	const baseline = padding + ascent;
	glow.font = word.fontString;
	glow.textAlign = word.direction === "rtl" ? "right" : "left";
	glow.textBaseline = "alphabetic";
	glow.direction = word.direction;
	glow.fillStyle = word.color;
	glow.shadowColor = word.color;
	glow.shadowBlur = blur;
	glow.fillText(word.drawText, originX, baseline);

	// Remove the solid glyph from this pass. Only its emitted halo remains.
	glow.globalCompositeOperation = "destination-out";
	glow.shadowBlur = 0;
	glow.fillText(word.drawText, originX, baseline);

	// Reveal the halo cumulatively with a soft writing-direction edge.
	glow.globalCompositeOperation = "destination-in";
	if (progress >= 0.999) {
		glow.fillStyle = "#fff";
		glow.fillRect(0, 0, width, height);
	} else {
	const feather = Math.max(3, Math.min(word.width * 0.2, word.scaledFontSize * 0.35));
	const edge =
		word.glowerDirection === "rtl"
			? padding + word.width * (1 - progress)
			: padding + word.width * progress;
	const mask = glow.createLinearGradient(edge - feather, 0, edge + feather, 0);
	if (word.glowerDirection === "rtl") {
		mask.addColorStop(0, "rgba(255,255,255,0)");
		mask.addColorStop(1, "rgba(255,255,255,1)");
	} else {
		mask.addColorStop(0, "rgba(255,255,255,1)");
		mask.addColorStop(1, "rgba(255,255,255,0)");
	}
	glow.fillStyle = mask;
	glow.fillRect(0, 0, width, height);
	}

	const glyphLeft = word.direction === "rtl" ? -word.width : 0;
	ctx.save();
	ctx.globalCompositeOperation = "screen";
	ctx.globalAlpha *= 0.78;
	ctx.drawImage(glowCanvas, glyphLeft - padding, -ascent - padding);
	ctx.restore();
}

function applyTextShadow({
	ctx,
	shadow,
}: {
	ctx: TextCanvasContext;
	shadow?: ResolvedTextShadow | null;
}): void {
	if (
		!shadow ||
		(shadow.blur <= 0 && shadow.offsetX === 0 && shadow.offsetY === 0)
	) {
		ctx.shadowBlur = 0;
		ctx.shadowColor = "rgba(0,0,0,0)";
		ctx.shadowOffsetX = 0;
		ctx.shadowOffsetY = 0;
		return;
	}

	ctx.shadowBlur = Math.max(0, shadow.blur);
	ctx.shadowColor = shadow.color;
	ctx.shadowOffsetX = shadow.offsetX;
	ctx.shadowOffsetY = shadow.offsetY;
}

function drawWordBackground({
	ctx,
	word,
}: {
	ctx: TextCanvasContext;
	word: MeasuredWordGlyph;
}): void {
	const background = word.background;
	if (
		!background?.enabled ||
		!background.color ||
		background.color === "transparent"
	) {
		return;
	}

	const ascent =
		word.metrics.actualBoundingBoxAscent || word.scaledFontSize * 0.8;
	const descent =
		word.metrics.actualBoundingBoxDescent || word.scaledFontSize * 0.2;
	const left = background.offsetX - background.paddingX;
	const top = background.offsetY - ascent - background.paddingY;
	const width = word.width + background.paddingX * 2;
	const height = ascent + descent + background.paddingY * 2;
	if (width <= 0 || height <= 0) return;

	const radiusPercent =
		clamp({
			value: background.cornerRadius,
			min: CORNER_RADIUS_MIN,
			max: CORNER_RADIUS_MAX,
		}) / 100;
	const radius = (Math.min(width, height) / 2) * radiusPercent;
	ctx.save();
	ctx.fillStyle = background.color;
	ctx.beginPath();
	ctx.roundRect(left, top, width, height, radius);
	ctx.fill();
	ctx.restore();
}

function toCanvasCompositeOperation(
	blendMode: BlendMode | undefined,
): GlobalCompositeOperation {
	if (!blendMode || blendMode === "normal") {
		return "source-over";
	}
	if (blendMode === "plus-lighter") {
		return "lighter";
	}
	return blendMode as GlobalCompositeOperation;
}

export function strokeMeasuredTextLayout({
	ctx,
	layout,
	strokeColor,
	strokeWidth,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextLayout;
	strokeColor: string;
	strokeWidth: number;
	textBaseline?: CanvasTextBaseline;
}): void {
	ctx.font = layout.fontString;
	ctx.textAlign = layout.textAlign;
	ctx.textBaseline = textBaseline;
	ctx.strokeStyle = strokeColor;
	ctx.lineWidth = strokeWidth;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });

	for (let index = 0; index < layout.lines.length; index++) {
		const lineY = index * layout.lineHeightPx - layout.block.visualCenterOffset;
		ctx.strokeText(layout.lines[index], 0, lineY);
	}
}
