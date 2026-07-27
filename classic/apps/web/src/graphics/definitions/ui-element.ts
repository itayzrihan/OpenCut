import type { ParamDefinition } from "@/params";
import {
	UI_ELEMENT_TEMPLATE_OPTIONS,
	UI_ELEMENT_TEXT_REVEAL_OPTIONS,
	UI_ELEMENT_TEXT_TRANSITION_OPTIONS,
	getAllUiElementAnimationOptions,
} from "@/ui-elements/animation-options";
import type { TextCaptionRevealMode, TextWordTransitionIn } from "@/timeline";
import type { GraphicDefinition } from "../types";

export const UI_ELEMENT_GRAPHIC_ID = "ui-element";

interface UiElementParams {
	template: string;
	label: string;
	secondary: string;
	items: string;
	itemCount: number;
	labelFontFamily: string;
	secondaryFontFamily: string;
	itemsFontFamily: string;
	textDirection: string;
	textRevealMode: TextCaptionRevealMode;
	textTransitionIn: TextWordTransitionIn;
	animationIn: string;
	animationInEnd: number;
	animationOut: string;
	animationOutStart: number;
	animationStrength: number;
	eventAt: number;
	itemStartPoints: string;
	itemEndPoints: string;
	listRevealMode: string;
	listBaseOpacity: number;
	listRiseDistance: number;
	listItemInDuration: number;
	listItemOutDuration: number;
	listBarWidth: number;
	listBarHeight: number;
	listBarGap: number;
	listBarRadius: number;
	listBarFitToText: boolean;
	listBackgroundBlur: number;
	listTextAlign: string;
	listTextSize: number;
	accent: string;
	background: string;
	foreground: string;
	progress: number;
	batteryMode: string;
	screenMode: string;
	checked: number;
	count: number;
	intensity: number;
}

const UI_ELEMENT_PARAMS: ParamDefinition<keyof UiElementParams & string>[] = [
	{
		key: "template",
		label: "Template",
		type: "select",
		default: "neon-button",
		keyframable: false,
		options: [...UI_ELEMENT_TEMPLATE_OPTIONS],
	},
	{ key: "label", label: "Text", type: "text", default: "Continue" },
	{ key: "secondary", label: "Secondary", type: "text", default: "Details" },
	{
		key: "items",
		label: "Items",
		type: "text",
		default: "Research\nDesign\nEdit\nPublish",
	},
	{
		key: "itemCount",
		label: "Item Count",
		type: "number",
		default: 4,
		min: 1,
		max: 8,
		step: 1,
		keyframable: false,
	},
	{
		key: "labelFontFamily",
		label: "Text Font",
		type: "font",
		default: "Inter",
		keyframable: false,
	},
	{
		key: "secondaryFontFamily",
		label: "Secondary Font",
		type: "font",
		default: "Inter",
		keyframable: false,
	},
	{
		key: "itemsFontFamily",
		label: "Items Font",
		type: "font",
		default: "Inter",
		keyframable: false,
	},
	{
		key: "textDirection",
		label: "Direction",
		type: "select",
		default: "auto",
		keyframable: false,
		options: [
			{ value: "auto", label: "Auto" },
			{ value: "ltr", label: "Left to Right" },
			{ value: "rtl", label: "Right to Left" },
		],
	},
	{
		key: "textRevealMode",
		label: "Text Reveal",
		type: "select",
		default: "determined-by-preset",
		keyframable: false,
		options: UI_ELEMENT_TEXT_REVEAL_OPTIONS,
	},
	{
		key: "textTransitionIn",
		label: "Text Transition",
		type: "select",
		default: "blur-zoom",
		keyframable: false,
		options: UI_ELEMENT_TEXT_TRANSITION_OPTIONS,
	},
	{
		key: "animationIn",
		label: "Animation In",
		type: "select",
		default: "auto",
		keyframable: false,
		options: getAllUiElementAnimationOptions({ side: "in" }),
	},
	{
		key: "animationInEnd",
		label: "In Ends",
		type: "number",
		default: 18,
		min: 1,
		max: 95,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "animationOut",
		label: "Animation Out",
		type: "select",
		default: "auto",
		keyframable: false,
		options: getAllUiElementAnimationOptions({ side: "out" }),
	},
	{
		key: "animationOutStart",
		label: "Out Starts",
		type: "number",
		default: 82,
		min: 5,
		max: 99,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "animationStrength",
		label: "Motion Strength",
		type: "number",
		default: 100,
		min: 0,
		max: 200,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "eventAt",
		label: "Event Moment",
		type: "number",
		default: 55,
		min: 0,
		max: 100,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "itemStartPoints",
		label: "Item Starts",
		type: "text",
		default: "",
		keyframable: false,
	},
	{
		key: "listRevealMode",
		label: "List Reveal",
		type: "select",
		default: "sequential",
		keyframable: false,
		options: [
			{ value: "sequential", label: "Exact one by one" },
			{ value: "ghost-stagger", label: "Ghost then rise" },
			{ value: "all-at-once", label: "Reveal all at once" },
			{ value: "all-then-check", label: "All, then checkmarks" },
		],
	},
	{
		key: "listBaseOpacity",
		label: "Pre-Reveal Opacity",
		type: "number",
		default: 0,
		min: 0,
		max: 1,
		step: 0.01,
		keyframable: false,
	},
	{
		key: "listRiseDistance",
		label: "Rise Distance",
		type: "number",
		default: 36,
		min: 0,
		max: 160,
		step: 1,
		keyframable: false,
	},
	{
		key: "listItemInDuration",
		label: "Item In Length",
		type: "number",
		default: 8,
		min: 0,
		max: 50,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "listItemOutDuration",
		label: "Item Out Length",
		type: "number",
		default: 8,
		min: 0,
		max: 50,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "listBarWidth",
		label: "Bar Width",
		type: "number",
		default: 54,
		min: 20,
		max: 90,
		step: 1,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "listBarHeight",
		label: "Bar Height",
		type: "number",
		default: 8,
		min: 3,
		max: 18,
		step: 0.5,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "listBarGap",
		label: "Bar Gap",
		type: "number",
		default: 2.5,
		min: 0,
		max: 12,
		step: 0.5,
		unit: "percent",
		keyframable: false,
	},
	{
		key: "listBarRadius",
		label: "Bar Radius",
		type: "number",
		default: 14,
		min: 0,
		max: 60,
		step: 1,
		keyframable: false,
	},
	{
		key: "listBarFitToText",
		label: "Fit Width To Text",
		type: "boolean",
		default: false,
		keyframable: false,
	},
	{
		key: "listBackgroundBlur",
		label: "Background Blur",
		type: "number",
		default: 0,
		min: 0,
		max: 30,
		step: 1,
		keyframable: false,
	},
	{
		key: "listTextAlign",
		label: "Text Align",
		type: "select",
		default: "auto",
		keyframable: false,
		options: [
			{ value: "auto", label: "Auto" },
			{ value: "left", label: "Left" },
			{ value: "center", label: "Center" },
			{ value: "right", label: "Right" },
		],
	},
	{
		key: "listTextSize",
		label: "Text Size",
		type: "number",
		default: 28,
		min: 12,
		max: 72,
		step: 1,
		keyframable: false,
	},
	{
		key: "itemEndPoints",
		label: "Item Ends",
		type: "text",
		default: "",
		keyframable: false,
	},
	{ key: "accent", label: "Accent", type: "color", default: "#00e5ff" },
	{ key: "background", label: "Background", type: "color", default: "#111827" },
	{ key: "foreground", label: "Text Color", type: "color", default: "#ffffff" },
	{
		key: "progress",
		label: "Progress",
		type: "number",
		default: 64,
		min: 0,
		max: 100,
		step: 1,
		unit: "percent",
	},
	{
		key: "batteryMode",
		label: "Battery Mode",
		type: "select",
		default: "drain",
		keyframable: false,
		options: [
			{ value: "drain", label: "Draining" },
			{ value: "charge", label: "Charging" },
		],
	},
	{
		key: "screenMode",
		label: "Screen Mode",
		type: "select",
		default: "auto",
		keyframable: false,
		options: [
			{ value: "auto", label: "Auto" },
			{ value: "wide", label: "Wide" },
			{ value: "vertical", label: "Vertical" },
			{ value: "square", label: "1:1 Square" },
		],
	},
	{
		key: "checked",
		label: "Checked",
		type: "number",
		default: 2,
		min: 0,
		max: 10,
		step: 1,
	},
	{
		key: "count",
		label: "Count",
		type: "number",
		default: 3,
		min: 0,
		max: 9999,
		step: 1,
	},
	{
		key: "intensity",
		label: "Intensity",
		type: "number",
		default: 60,
		min: 0,
		max: 100,
		step: 1,
	},
];

function clampValue({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.min(max, Math.max(min, value));
}

function splitItems(value: string): string[] {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, 8);
}

function buildItems({
	value,
	count,
}: {
	value: string;
	count: number;
}): string[] {
	const rawItems = splitItems(value);
	return Array.from({ length: count }, (_, index) => {
		return rawItems[index] ?? `Item ${index + 1}`;
	});
}

function isLikelyRtlText({ text }: { text: string }): boolean {
	return /[\u0590-\u08ff]/.test(text);
}

function parsePercentPoints({
	value,
	count,
	fallback,
}: {
	value: string;
	count: number;
	fallback: (index: number) => number;
}): number[] {
	const parsed = value
		.split(",")
		.map((entry) => Number(entry.trim()))
		.filter((entry) => Number.isFinite(entry));
	return Array.from({ length: count }, (_, index) =>
		clampValue({
			value: parsed[index] ?? fallback(index),
			min: 0,
			max: 100,
		}),
	);
}

type OverlayScreenMode = "auto" | "wide" | "vertical" | "square";

function resolveOverlayScreenMode({
	value,
	width,
	height,
}: {
	value: string;
	width: number;
	height: number;
}): Exclude<OverlayScreenMode, "auto"> {
	if (value === "wide" || value === "vertical" || value === "square") {
		return value;
	}
	const aspect = width / Math.max(1, height);
	if (aspect < 0.82) return "vertical";
	if (aspect < 1.18) return "square";
	return "wide";
}

function getUiElementSourceSize({
	params,
}: {
	params: Record<string, unknown>;
}): { width: number; height: number } {
	if (String(params.template ?? "") !== "wasted-overlay") {
		return { width: 1200, height: 675 };
	}
	const mode = String(params.screenMode ?? "wide");
	if (mode === "vertical") {
		return { width: 1080, height: 1920 };
	}
	if (mode === "square") {
		return { width: 1080, height: 1080 };
	}
	return { width: 1920, height: 1080 };
}

function withAlpha({ color, alpha }: { color: string; alpha: number }) {
	const safeAlpha = clampValue({ value: alpha, min: 0, max: 1 });
	if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
		const normalized =
			color.length === 4
				? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
				: color;
		const red = Number.parseInt(normalized.slice(1, 3), 16);
		const green = Number.parseInt(normalized.slice(3, 5), 16);
		const blue = Number.parseInt(normalized.slice(5, 7), 16);
		return `rgba(${red}, ${green}, ${blue}, ${safeAlpha})`;
	}
	return color;
}

function roundRect({
	x,
	y,
	width,
	height,
	radius,
}: {
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
}): Path2D {
	const path = new Path2D();
	path.roundRect(x, y, width, height, radius);
	return path;
}

interface TextMotion {
	revealMode: TextCaptionRevealMode;
	transitionIn: TextWordTransitionIn;
	direction: "auto" | "ltr" | "rtl";
	progress: number;
	order?: number;
	total?: number;
}

function fontStack({ family }: { family: string }): string {
	const safeFamily = family.replace(/"/g, "");
	return `"${safeFamily}", Inter, Arial, sans-serif`;
}

function setCanvasFont({
	ctx,
	weight,
	size,
	fontFamily,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	weight: number;
	size: number;
	fontFamily: string;
}) {
	ctx.font = `${weight} ${size}px ${fontStack({ family: fontFamily })}`;
}

function easeOutCubic(value: number): number {
	const t = clampValue({ value, min: 0, max: 1 });
	return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(value: number): number {
	const t = clampValue({ value, min: 0, max: 1 });
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function getOrderedTextProgress({ motion }: { motion?: TextMotion }): number {
	if (!motion) return 1;
	const total = Math.max(1, motion.total ?? 1);
	const order = clampValue({
		value: motion.order ?? 0,
		min: 0,
		max: total - 1,
	});
	const delay = total <= 1 ? 0 : (order / total) * 0.42;
	const progress = (motion.progress - delay) / Math.max(0.001, 1 - delay);
	return easeOutCubic(clampValue({ value: progress, min: 0, max: 1 }));
}

function getVisibleText({
	text,
	motion,
	progress,
}: {
	text: string;
	motion?: TextMotion;
	progress: number;
}): string {
	if (
		motion?.revealMode === "letter-by-letter" ||
		motion?.transitionIn === "typewriter"
	) {
		return text.slice(0, Math.ceil(text.length * progress));
	}
	return text;
}

function fitText({
	ctx,
	text,
	maxWidth,
	startSize,
	minSize = 18,
	weight = 800,
	fontFamily = "Inter",
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	maxWidth: number;
	startSize: number;
	minSize?: number;
	weight?: number;
	fontFamily?: string;
}): number {
	let size = startSize;
	while (size > minSize) {
		setCanvasFont({ ctx, weight, size, fontFamily });
		if (ctx.measureText(text).width <= maxWidth) {
			return size;
		}
		size -= 2;
	}
	return minSize;
}

function drawTextLine({
	ctx,
	text,
	x,
	y,
	maxWidth,
	size,
	color,
	fontFamily,
	weight = 800,
	align = "center",
	motion,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	x: number;
	y: number;
	maxWidth: number;
	size: number;
	color: string;
	fontFamily: string;
	weight?: number;
	align?: CanvasTextAlign;
	motion?: TextMotion;
}) {
	const progress = getOrderedTextProgress({ motion });
	const visibleText = getVisibleText({ text, motion, progress });
	const fontSize = fitText({
		ctx,
		text,
		maxWidth,
		startSize: size,
		weight,
		fontFamily,
	});

	ctx.save();
	const easedScale =
		motion?.transitionIn === "zoom" || motion?.transitionIn === "blur-zoom"
			? 0.84 + progress * 0.16
			: 1;
	const slideOffset =
		motion?.transitionIn === "slide" ? (1 - progress) * -34 : 0;
	const riseOffset = motion?.transitionIn === "rise" ? (1 - progress) * 26 : 0;
	ctx.translate(x + slideOffset, y + riseOffset);
	ctx.scale(easedScale, easedScale);
	ctx.globalAlpha *=
		motion?.transitionIn === "none" && motion.revealMode === "row"
			? 1
			: 0.08 + progress * 0.92;
	if (motion?.transitionIn === "blur" || motion?.transitionIn === "blur-zoom") {
		ctx.filter = `blur(${(1 - progress) * 8}px)`;
	}
	if (motion?.transitionIn === "glow-dissolve") {
		ctx.shadowColor = color;
		ctx.shadowBlur = 24 * (1 - progress) + 10 * progress;
	}
	if (motion?.revealMode === "emphasize-spoken") {
		ctx.shadowColor = color;
		ctx.shadowBlur = 8 * progress;
	}
	if (motion?.revealMode === "growing-row") {
		const clipX = align === "center" ? -maxWidth / 2 : 0;
		ctx.beginPath();
		ctx.rect(clipX, -fontSize, maxWidth * progress, fontSize * 2);
		ctx.clip();
	}
	setCanvasFont({ ctx, weight, size: fontSize, fontFamily });
	ctx.fillStyle = color;
	ctx.textAlign = align;
	ctx.direction =
		motion?.direction === "rtl"
			? "rtl"
			: motion?.direction === "ltr"
				? "ltr"
				: isLikelyRtlText({ text })
					? "rtl"
					: "ltr";
	ctx.textBaseline = "middle";
	ctx.fillText(visibleText, 0, 0, maxWidth);
	ctx.restore();
}

function drawCenteredText({
	ctx,
	text,
	x,
	y,
	maxWidth,
	size,
	color,
	fontFamily,
	weight = 800,
	motion,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	x: number;
	y: number;
	maxWidth: number;
	size: number;
	color: string;
	fontFamily: string;
	weight?: number;
	motion?: TextMotion;
}) {
	drawTextLine({
		ctx,
		text,
		x,
		y,
		maxWidth,
		size,
		color,
		fontFamily,
		weight,
		align: "center",
		motion,
	});
}

interface UiMotionTiming {
	timelineProgress: number;
	inProgress: number;
	outProgress: number;
	eventProgress: number;
	contentProgress: number;
	textMotion: TextMotion;
}

interface UiMotionTransform {
	opacity: number;
	x: number;
	y: number;
	scaleX: number;
	scaleY: number;
	rotate: number;
	clipX: number;
	blur: number;
}

function resolveUiMotionTiming({
	localTime,
	duration,
	animationInEnd,
	animationOutStart,
	eventAt,
	textRevealMode,
	textTransitionIn,
	textDirection,
}: {
	localTime: number;
	duration?: number;
	animationInEnd: number;
	animationOutStart: number;
	eventAt: number;
	textRevealMode: TextCaptionRevealMode;
	textTransitionIn: TextWordTransitionIn;
	textDirection: "auto" | "ltr" | "rtl";
}): UiMotionTiming {
	if (!duration || duration <= 0) {
		return {
			timelineProgress: 0.5,
			inProgress: 1,
			outProgress: 0,
			eventProgress: 1,
			contentProgress: 1,
			textMotion: {
				revealMode: textRevealMode,
				transitionIn: textTransitionIn,
				direction: textDirection,
				progress: 1,
			},
		};
	}

	const timelineProgress = clampValue({
		value: localTime / duration,
		min: 0,
		max: 1,
	});
	const inEnd = clampValue({
		value: animationInEnd / 100,
		min: 0.01,
		max: 0.95,
	});
	const outStart = clampValue({
		value: animationOutStart / 100,
		min: inEnd + 0.01,
		max: 0.99,
	});
	const eventStart = clampValue({
		value: eventAt / 100,
		min: 0,
		max: 0.99,
	});
	const inProgress = easeOutCubic(
		clampValue({ value: timelineProgress / inEnd, min: 0, max: 1 }),
	);
	const outProgress = easeOutCubic(
		clampValue({
			value: (timelineProgress - outStart) / Math.max(0.001, 1 - outStart),
			min: 0,
			max: 1,
		}),
	);
	const eventProgress = easeOutCubic(
		clampValue({
			value: (timelineProgress - eventStart) / Math.max(0.001, 1 - eventStart),
			min: 0,
			max: 1,
		}),
	);
	const contentProgress = Math.min(inProgress, 1 - outProgress * 0.85);

	return {
		timelineProgress,
		inProgress,
		outProgress,
		eventProgress,
		contentProgress,
		textMotion: {
			revealMode: textRevealMode,
			transitionIn: textTransitionIn,
			direction: textDirection,
			progress: contentProgress,
		},
	};
}

function baseMotionTransform(): UiMotionTransform {
	return {
		opacity: 1,
		x: 0,
		y: 0,
		scaleX: 1,
		scaleY: 1,
		rotate: 0,
		clipX: 1,
		blur: 0,
	};
}

function buildInTransform({
	animation,
	progress,
	width,
	height,
}: {
	animation: string;
	progress: number;
	width: number;
	height: number;
}): UiMotionTransform {
	const t = baseMotionTransform();
	const p = clampValue({ value: progress, min: 0, max: 1 });
	const inverse = 1 - p;
	t.opacity = p;

	if (animation === "auto") {
		t.scaleX = 0.92 + p * 0.08;
		t.scaleY = 0.92 + p * 0.08;
		return t;
	}

	if (animation.includes("slide") || animation.includes("swipe")) {
		t.x = -width * 0.18 * inverse;
	}
	if (animation.includes("drop")) {
		t.y = -height * 0.22 * inverse;
	}
	if (animation.includes("rise")) {
		t.y = height * 0.18 * inverse;
	}
	if (
		animation.includes("pop") ||
		animation.includes("snap") ||
		animation.includes("stamp") ||
		animation.includes("bounce")
	) {
		const scale = clampValue({ value: easeOutBack(p), min: 0.15, max: 1.18 });
		t.scaleX = scale;
		t.scaleY = scale;
	}
	if (
		animation.includes("spin") ||
		animation.includes("orbit") ||
		animation.includes("comet") ||
		animation.includes("flip")
	) {
		t.rotate = -Math.PI * inverse;
		t.scaleX = Math.max(0.12, p);
	}
	if (
		animation.includes("wipe") ||
		animation.includes("draw") ||
		animation.includes("unmask") ||
		animation.includes("build") ||
		animation.includes("open") ||
		animation.includes("fill")
	) {
		t.clipX = p;
	}
	if (
		animation.includes("glow") ||
		animation.includes("neon") ||
		animation.includes("charge") ||
		animation.includes("pulse")
	) {
		t.scaleX = 0.84 + p * 0.16;
		t.scaleY = 0.84 + p * 0.16;
		t.blur = inverse * 4;
	}
	return t;
}

function buildOutTransform({
	animation,
	progress,
	width,
	height,
}: {
	animation: string;
	progress: number;
	width: number;
	height: number;
}): UiMotionTransform {
	const t = baseMotionTransform();
	const p = clampValue({ value: progress, min: 0, max: 1 });
	t.opacity = 1 - p;

	if (animation === "auto") {
		t.scaleX = 1 - p * 0.08;
		t.scaleY = 1 - p * 0.08;
		return t;
	}

	if (
		animation.includes("explode") ||
		animation.includes("burst") ||
		animation.includes("shatter") ||
		animation.includes("break") ||
		animation.includes("scatter")
	) {
		t.scaleX = 1 + p * 0.42;
		t.scaleY = 1 + p * 0.42;
		t.rotate = p * 0.18;
	}
	if (
		animation.includes("shrink") ||
		animation.includes("collapse") ||
		animation.includes("compress") ||
		animation.includes("close") ||
		animation.includes("fold")
	) {
		t.scaleX = 1 - p * 0.78;
		t.scaleY = 1 - p * 0.78;
	}
	if (
		animation.includes("slide") ||
		animation.includes("swipe") ||
		animation.includes("release") ||
		animation.includes("fly") ||
		animation.includes("zip")
	) {
		t.x = width * 0.24 * p;
	}
	if (animation.includes("drop") || animation.includes("fall")) {
		t.y = height * 0.28 * p;
	}
	if (
		animation.includes("erase") ||
		animation.includes("wipe") ||
		animation.includes("drain") ||
		animation.includes("clear") ||
		animation.includes("blank") ||
		animation.includes("cut")
	) {
		t.clipX = 1 - p;
	}
	if (animation.includes("flip") || animation.includes("spinout")) {
		t.rotate = Math.PI * p;
		t.scaleY = Math.max(0.12, 1 - p * 0.84);
	}
	if (
		animation.includes("burn") ||
		animation.includes("dim") ||
		animation.includes("mute") ||
		animation.includes("fade")
	) {
		t.blur = p * 5;
	}
	return t;
}

function composeMotionTransforms({
	enter,
	exit,
	strength,
}: {
	enter: UiMotionTransform;
	exit: UiMotionTransform;
	strength: number;
}): UiMotionTransform {
	const safeStrength = clampValue({ value: strength, min: 0, max: 2 });
	const opacity = enter.opacity * exit.opacity;
	const scaleX = enter.scaleX * exit.scaleX;
	const scaleY = enter.scaleY * exit.scaleY;
	return {
		opacity: clampValue({
			value: 1 - (1 - opacity) * safeStrength,
			min: 0,
			max: 1,
		}),
		x: (enter.x + exit.x) * safeStrength,
		y: (enter.y + exit.y) * safeStrength,
		scaleX: 1 + (scaleX - 1) * safeStrength,
		scaleY: 1 + (scaleY - 1) * safeStrength,
		rotate: (enter.rotate + exit.rotate) * safeStrength,
		clipX: Math.min(enter.clipX, exit.clipX),
		blur: Math.max(enter.blur, exit.blur) * safeStrength,
	};
}

function drawMotionFragments({
	ctx,
	width,
	height,
	color,
	progress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	color: string;
	progress: number;
}) {
	if (progress <= 0) return;
	ctx.save();
	ctx.fillStyle = color;
	ctx.globalAlpha *= 1 - progress;
	for (let index = 0; index < 16; index++) {
		const angle = (Math.PI * 2 * index) / 16;
		const distance = width * 0.06 + width * 0.22 * progress;
		const x = width / 2 + Math.cos(angle) * distance;
		const y = height / 2 + Math.sin(angle) * distance * 0.56;
		const size = 7 + (index % 4) * 4;
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(angle + progress * Math.PI);
		ctx.fillRect(-size / 2, -size / 2, size, size);
		ctx.restore();
	}
	ctx.restore();
}

function withUiMotion({
	ctx,
	width,
	height,
	animationIn,
	animationOut,
	timing,
	animationStrength,
	accent,
	render,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	animationIn: string;
	animationOut: string;
	timing: UiMotionTiming;
	animationStrength: number;
	accent: string;
	render: () => void;
}) {
	const transform = composeMotionTransforms({
		enter: buildInTransform({
			animation: animationIn,
			progress: timing.inProgress,
			width,
			height,
		}),
		exit: buildOutTransform({
			animation: animationOut,
			progress: timing.outProgress,
			width,
			height,
		}),
		strength: animationStrength,
	});

	ctx.save();
	if (transform.clipX < 0.999) {
		const clipWidth = width * transform.clipX;
		ctx.beginPath();
		ctx.rect((width - clipWidth) / 2, 0, clipWidth, height);
		ctx.clip();
	}
	ctx.translate(width / 2 + transform.x, height / 2 + transform.y);
	ctx.rotate(transform.rotate);
	ctx.scale(transform.scaleX, transform.scaleY);
	ctx.translate(-width / 2, -height / 2);
	ctx.globalAlpha *= transform.opacity;
	if (transform.blur > 0) {
		ctx.filter = `blur(${transform.blur}px)`;
	}
	render();
	if (
		animationOut.includes("explode") ||
		animationOut.includes("burst") ||
		animationOut.includes("shatter") ||
		animationOut.includes("break") ||
		animationOut.includes("scatter")
	) {
		drawMotionFragments({
			ctx,
			width,
			height,
			color: accent,
			progress: timing.outProgress,
		});
	}
	ctx.restore();
}

function drawButton({
	ctx,
	width,
	height,
	label,
	labelFontFamily,
	accent,
	background,
	foreground,
	localTime,
	textMotion,
	click = false,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	labelFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	localTime: number;
	textMotion: TextMotion;
	click?: boolean;
}) {
	const pulse = 0.5 + Math.sin(localTime * Math.PI * 2) * 0.5;
	const buttonWidth = width * 0.58;
	const buttonHeight = height * 0.22;
	const x = (width - buttonWidth) / 2;
	const y = (height - buttonHeight) / 2;
	const radius = buttonHeight / 2;
	const path = roundRect({
		x,
		y,
		width: buttonWidth,
		height: buttonHeight,
		radius,
	});
	ctx.shadowColor = accent;
	ctx.shadowBlur = 28 + pulse * 20;
	ctx.fillStyle = background;
	ctx.fill(path);
	ctx.shadowBlur = 0;
	ctx.lineWidth = 5;
	ctx.strokeStyle = accent;
	ctx.stroke(path);
	if (click) {
		const baseAlpha = ctx.globalAlpha;
		ctx.globalAlpha = baseAlpha * 0.28 * pulse;
		ctx.lineWidth = 10;
		ctx.stroke(
			roundRect({
				x: x - 22 * pulse,
				y: y - 22 * pulse,
				width: buttonWidth + 44 * pulse,
				height: buttonHeight + 44 * pulse,
				radius: radius + 22 * pulse,
			}),
		);
		ctx.globalAlpha = baseAlpha;
	}
	drawCenteredText({
		ctx,
		text: label,
		x: width / 2,
		y: height / 2,
		maxWidth: buttonWidth * 0.78,
		size: 54,
		color: foreground,
		fontFamily: labelFontFamily,
		motion: textMotion,
	});
}

function measureListFitWidth({
	ctx,
	items,
	itemsFontFamily,
	listTextSize,
	maxWidth,
	barHeight,
	checkbox,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	items: string[];
	itemsFontFamily: string;
	listTextSize: number;
	maxWidth: number;
	barHeight: number;
	checkbox: boolean;
}) {
	ctx.save();
	setCanvasFont({
		ctx,
		weight: 600,
		size: listTextSize,
		fontFamily: itemsFontFamily,
	});
	const longestTextWidth = items.reduce(
		(maxWidthSoFar, item) =>
			Math.max(maxWidthSoFar, ctx.measureText(item).width),
		0,
	);
	ctx.restore();

	const iconInset = Math.max(16, Math.min(34, barHeight * 0.42));
	const iconSize = checkbox
		? Math.max(18, Math.min(34, barHeight * 0.48))
		: Math.max(8, Math.min(18, barHeight * 0.18)) * 2;
	const sidePadding = Math.max(20, barHeight * 0.4);
	return clampValue({
		value: longestTextWidth + iconInset + iconSize + sidePadding * 3,
		min: Math.min(maxWidth, 180),
		max: maxWidth,
	});
}

function drawListBarBackground({
	ctx,
	x,
	y,
	width,
	height,
	radius,
	color,
	blur,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
	color: string;
	blur: number;
}) {
	if (blur > 0) {
		ctx.save();
		ctx.filter = `blur(${blur}px)`;
		ctx.globalAlpha *= 0.55;
		ctx.fillStyle = color;
		ctx.fill(
			roundRect({
				x: x - blur * 0.35,
				y: y - blur * 0.35,
				width: width + blur * 0.7,
				height: height + blur * 0.7,
				radius: radius + blur * 0.45,
			}),
		);
		ctx.restore();
	}

	ctx.fillStyle = blur > 0 ? withAlpha({ color, alpha: 0.82 }) : color;
	ctx.fill(roundRect({ x, y, width, height, radius }));
}

function resolveListTextLayout({
	x,
	width,
	barHeight,
	rowIsRtl,
	checkbox,
	listTextAlign,
}: {
	x: number;
	width: number;
	barHeight: number;
	rowIsRtl: boolean;
	checkbox: boolean;
	listTextAlign: string;
}): { x: number; maxWidth: number; align: CanvasTextAlign } {
	const iconInset = Math.max(16, Math.min(34, barHeight * 0.42));
	const iconSize = checkbox
		? Math.max(18, Math.min(34, barHeight * 0.48))
		: Math.max(8, Math.min(18, barHeight * 0.18)) * 2;
	const iconReserve = iconInset + iconSize + Math.max(14, barHeight * 0.28);
	const outerInset = Math.max(18, barHeight * 0.34);
	const areaLeft = x + (rowIsRtl ? outerInset : iconReserve);
	const areaRight = x + width - (rowIsRtl ? iconReserve : outerInset);
	const maxWidth = Math.max(24, areaRight - areaLeft);
	const align =
		listTextAlign === "left" ||
		listTextAlign === "center" ||
		listTextAlign === "right"
			? listTextAlign
			: rowIsRtl
				? "right"
				: "left";
	if (align === "center") {
		return { x: areaLeft + maxWidth / 2, maxWidth, align };
	}
	if (align === "right") {
		return { x: areaRight, maxWidth, align };
	}
	return { x: areaLeft, maxWidth, align };
}

function drawList({
	ctx,
	width,
	height,
	items,
	itemsFontFamily,
	accent,
	background,
	foreground,
	checked,
	checkbox,
	textMotion,
	animationIn,
	inProgress,
	outProgress,
	eventProgress,
	timelineProgress,
	itemStartPoints,
	itemEndPoints,
	listRevealMode,
	listBaseOpacity,
	listRiseDistance,
	listItemInDuration,
	listItemOutDuration,
	listBarWidth,
	listBarHeight,
	listBarGap,
	listBarRadius,
	listBarFitToText,
	listBackgroundBlur,
	listTextAlign,
	listTextSize,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	items: string[];
	itemsFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	checked: number;
	checkbox: boolean;
	textMotion: TextMotion;
	animationIn: string;
	inProgress: number;
	outProgress: number;
	eventProgress: number;
	timelineProgress: number;
	itemStartPoints: number[];
	itemEndPoints: number[];
	listRevealMode: string;
	listBaseOpacity: number;
	listRiseDistance: number;
	listItemInDuration: number;
	listItemOutDuration: number;
	listBarWidth: number;
	listBarHeight: number;
	listBarGap: number;
	listBarRadius: number;
	listBarFitToText: boolean;
	listBackgroundBlur: number;
	listTextAlign: string;
	listTextSize: number;
}) {
	const barHeight = height * (listBarHeight / 100);
	const rowHeight = barHeight + height * (listBarGap / 100);
	const startY = height * 0.2;
	const visibleItems = items.slice(0, 6);
	const maxListWidth = width * (listBarWidth / 100);
	const listWidth = listBarFitToText
		? measureListFitWidth({
				ctx,
				items: visibleItems,
				itemsFontFamily,
				listTextSize,
				maxWidth: maxListWidth,
				barHeight,
				checkbox,
			})
		: maxListWidth;
	const x = width / 2 - listWidth / 2;
	const instantRows =
		listRevealMode === "all-at-once" ||
		listRevealMode === "all-then-check" ||
		animationIn === "list-all-then-check";
	const ghostRows = listRevealMode === "ghost-stagger";
	const checkedProgress = checkbox ? eventProgress : 1;
	const timelinePercent = timelineProgress * 100;
	visibleItems.forEach((item, index) => {
		const delay = instantRows ? 0 : index * 0.11;
		const staggerEnter = clampValue({
			value: (inProgress - delay) / Math.max(0.001, 1 - delay),
			min: 0,
			max: 1,
		});
		const rowStart = itemStartPoints[index] ?? 0;
		const rowEnd = Math.max(rowStart + 1, itemEndPoints[index] ?? 100);
		const rowDuration = Math.max(1, rowEnd - rowStart);
		const rowEnter =
			listItemInDuration <= 0
				? timelinePercent >= rowStart
					? 1
					: 0
				: clampValue({
						value:
							(timelinePercent - rowStart) /
							Math.min(listItemInDuration, rowDuration),
						min: 0,
						max: 1,
					});
		const presetStaggerEnter =
			listRevealMode === "ghost-stagger" ||
			animationIn === "list-grow-glow-stagger"
				? Math.min(staggerEnter, rowEnter)
				: rowEnter;
		const enter = instantRows
			? 1
			: clampValue({ value: easeOutBack(presetStaggerEnter), min: 0, max: 1 });
		const rowTextProgress = instantRows ? inProgress : rowEnter;
		const exitDelay = outProgress <= 0 ? 0 : index * 0.04;
		const outExit = clampValue({
			value: (outProgress - exitDelay) / Math.max(0.001, 1 - exitDelay),
			min: 0,
			max: 1,
		});
		const rowExit =
			listItemOutDuration <= 0
				? timelinePercent >= rowEnd
					? 1
					: 0
				: clampValue({
						value:
							(timelinePercent - rowEnd) /
							Math.min(listItemOutDuration, rowDuration),
						min: 0,
						max: 1,
					});
		const exit = Math.max(outExit, rowExit);
		const y = startY + index * rowHeight + (1 - enter) * listRiseDistance;
		const preRevealOpacity = ghostRows
			? listBaseOpacity
			: listRevealMode === "all-at-once" || listRevealMode === "all-then-check"
				? 1
				: 0;
		const rowAlpha =
			(preRevealOpacity + enter * (1 - preRevealOpacity)) * (1 - exit);
		const barRadius = Math.min(listBarRadius, barHeight / 2);
		const rowCenterY = y + barHeight / 2;
		ctx.save();
		ctx.globalAlpha *= rowAlpha;
		if (animationIn === "list-grow-glow-stagger") {
			ctx.shadowColor = accent;
			ctx.shadowBlur = 18 * (1 - Math.abs(enter - 0.85));
		}
		if (outProgress > 0) {
			ctx.translate(exit * width * 0.16, exit * rowHeight * 0.4);
			ctx.scale(1 - exit * 0.12, 1 - exit * 0.12);
		}
		drawListBarBackground({
			ctx,
			x,
			y,
			width: listWidth,
			height: barHeight,
			radius: barRadius,
			color: background,
			blur: listBackgroundBlur,
		});
		const rowIsRtl =
			textMotion.direction === "rtl" ||
			(textMotion.direction === "auto" && isLikelyRtlText({ text: item }));
		const textLayout = resolveListTextLayout({
			x,
			width: listWidth,
			barHeight,
			rowIsRtl,
			checkbox,
			listTextAlign,
		});
		if (checkbox) {
			ctx.strokeStyle = index < checked ? accent : foreground;
			ctx.lineWidth = Math.max(2, Math.min(5, barHeight * 0.08));
			const checkboxSize = Math.max(18, Math.min(34, barHeight * 0.48));
			const checkboxInset = Math.max(16, Math.min(34, barHeight * 0.42));
			const checkboxX = rowIsRtl
				? x + listWidth - checkboxInset - checkboxSize
				: x + checkboxInset;
			const checkboxY = rowCenterY - checkboxSize / 2;
			ctx.strokeRect(checkboxX, checkboxY, checkboxSize, checkboxSize);
			if (index < checked * checkedProgress) {
				ctx.beginPath();
				ctx.moveTo(checkboxX + checkboxSize * 0.18, rowCenterY);
				ctx.lineTo(
					checkboxX + checkboxSize * 0.44,
					rowCenterY + checkboxSize * 0.28,
				);
				ctx.lineTo(
					checkboxX + checkboxSize * 0.92,
					rowCenterY - checkboxSize * 0.28,
				);
				ctx.stroke();
			}
			drawTextLine({
				ctx,
				text: item,
				x: textLayout.x,
				y: rowCenterY,
				maxWidth: textLayout.maxWidth,
				size: listTextSize,
				color: foreground,
				fontFamily: itemsFontFamily,
				weight: 600,
				align: textLayout.align,
				motion: {
					...textMotion,
					direction: rowIsRtl ? "rtl" : "ltr",
					progress: rowTextProgress,
				},
			});
			ctx.restore();
			return;
		}
		ctx.fillStyle = accent;
		ctx.beginPath();
		const bulletRadius = Math.max(8, Math.min(18, barHeight * 0.18));
		const bulletInset = Math.max(16, Math.min(34, barHeight * 0.42));
		ctx.arc(
			rowIsRtl ? x + listWidth - bulletInset - bulletRadius : x + bulletInset,
			rowCenterY,
			bulletRadius,
			0,
			Math.PI * 2,
		);
		ctx.fill();
		drawTextLine({
			ctx,
			text: item,
			x: textLayout.x,
			y: rowCenterY,
			maxWidth: textLayout.maxWidth,
			size: listTextSize,
			color: foreground,
			fontFamily: itemsFontFamily,
			weight: 600,
			align: textLayout.align,
			motion: {
				...textMotion,
				direction: rowIsRtl ? "rtl" : "ltr",
				progress: rowTextProgress,
			},
		});
		ctx.restore();
	});
}

function drawProgress({
	ctx,
	width,
	height,
	label,
	labelFontFamily,
	secondaryFontFamily,
	progress,
	accent,
	background,
	foreground,
	textMotion,
	animationIn,
	animationOut,
	inProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	progress: number;
	accent: string;
	background: string;
	foreground: string;
	textMotion: TextMotion;
	animationIn: string;
	animationOut: string;
	inProgress: number;
	outProgress: number;
}) {
	const x = width * 0.18;
	const y = height * 0.45;
	const barWidth = width * 0.64;
	const barHeight = height * 0.11;
	const buildProgress =
		animationIn.startsWith("progress-") || animationIn === "auto"
			? inProgress
			: 1;
	const outDrain =
		animationOut === "progress-drain-empty" ||
		animationOut === "progress-fill-collapse"
			? 1 - outProgress
			: 1;
	const overload =
		animationIn === "progress-overload-charge" ||
		animationOut === "progress-overload-burst";
	const visibleProgress = clampValue({
		value:
			progress * buildProgress * outDrain +
			(overload ? Math.sin(inProgress * Math.PI) * 8 : 0),
		min: 0,
		max: 110,
	});
	const flash =
		animationOut === "progress-complete-flash" && outProgress > 0
			? Math.sin(outProgress * Math.PI * 8) * 0.35
			: 0;
	ctx.fillStyle = background;
	ctx.fill(
		roundRect({
			x,
			y,
			width: barWidth,
			height: barHeight,
			radius: barHeight / 2,
		}),
	);
	ctx.fillStyle = accent;
	const baseAlpha = ctx.globalAlpha;
	ctx.globalAlpha =
		baseAlpha * clampValue({ value: 1 + flash, min: 0.2, max: 1 });
	ctx.fill(
		roundRect({
			x,
			y,
			width: Math.max(
				barHeight,
				(barWidth * clampValue({ value: visibleProgress, min: 0, max: 100 })) /
					100,
			),
			height: barHeight,
			radius: barHeight / 2,
		}),
	);
	ctx.globalAlpha = baseAlpha;
	if (
		animationIn === "progress-spark-run" ||
		animationOut === "progress-spark-dissolve"
	) {
		const sparkX =
			x +
			(barWidth * clampValue({ value: visibleProgress, min: 0, max: 100 })) /
				100;
		ctx.fillStyle = foreground;
		ctx.shadowColor = accent;
		ctx.shadowBlur = 22;
		ctx.beginPath();
		ctx.arc(sparkX, y + barHeight / 2, 10 + 10 * inProgress, 0, Math.PI * 2);
		ctx.fill();
		ctx.shadowBlur = 0;
	}
	drawCenteredText({
		ctx,
		text: label,
		x: width / 2,
		y: y - 60,
		maxWidth: barWidth,
		size: 40,
		color: foreground,
		fontFamily: labelFontFamily,
		motion: textMotion,
	});
	drawCenteredText({
		ctx,
		text: `${Math.round(visibleProgress)}%`,
		x: width / 2,
		y: y + barHeight / 2,
		maxWidth: barWidth,
		size: 32,
		color: foreground,
		fontFamily: secondaryFontFamily,
		motion: textMotion,
	});
}

function drawBars({
	ctx,
	width,
	height,
	accent,
	foreground,
	localTime,
	flip = false,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	accent: string;
	foreground: string;
	localTime: number;
	flip?: boolean;
}) {
	const count = 8;
	ctx.save();
	ctx.translate(width / 2, height / 2);
	if (!flip) {
		ctx.rotate(localTime * Math.PI * 2);
	}
	const baseAlpha = ctx.globalAlpha;
	for (let index = 0; index < count; index++) {
		const phase = localTime * 4 + index * 0.55;
		const barHeight = height * (0.16 + Math.abs(Math.sin(phase)) * 0.22);
		const x = (index - count / 2) * width * 0.055;
		ctx.fillStyle = index % 2 ? foreground : accent;
		ctx.globalAlpha = baseAlpha * (0.45 + Math.abs(Math.sin(phase)) * 0.55);
		ctx.fill(
			roundRect({
				x,
				y: -barHeight / 2,
				width: width * 0.028,
				height: barHeight,
				radius: width * 0.014,
			}),
		);
	}
	ctx.restore();
}

function drawChart({
	ctx,
	width,
	height,
	accent,
	foreground,
	line,
	motionProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	accent: string;
	foreground: string;
	line: boolean;
	motionProgress: number;
}) {
	const values = [0.32, 0.58, 0.44, 0.76, 0.62, 0.88, 0.72];
	const x = width * 0.2;
	const y = height * 0.24;
	const chartWidth = width * 0.6;
	const chartHeight = height * 0.48;
	ctx.strokeStyle = `${foreground}55`;
	ctx.lineWidth = 2;
	for (let i = 0; i < 4; i++) {
		const gridY = y + (chartHeight / 3) * i;
		ctx.beginPath();
		ctx.moveTo(x, gridY);
		ctx.lineTo(x + chartWidth, gridY);
		ctx.stroke();
	}
	if (line) {
		ctx.strokeStyle = accent;
		ctx.lineWidth = 8;
		ctx.lineJoin = "round";
		ctx.beginPath();
		values.forEach((value, index) => {
			const pointX = x + (chartWidth / (values.length - 1)) * index;
			const pointY =
				y +
				chartHeight -
				chartHeight *
					value *
					clampValue({ value: motionProgress, min: 0.2, max: 1 });
			if (index === 0) ctx.moveTo(pointX, pointY);
			else ctx.lineTo(pointX, pointY);
		});
		ctx.stroke();
		return;
	}
	values.forEach((value, index) => {
		const barWidth = (chartWidth / values.length) * 0.62;
		const pointX = x + (chartWidth / values.length) * index + barWidth * 0.3;
		const barHeight =
			chartHeight *
			value *
			clampValue({
				value: motionProgress - index * 0.08,
				min: 0.12,
				max: 1,
			});
		ctx.fillStyle = index % 2 ? foreground : accent;
		ctx.fill(
			roundRect({
				x: pointX,
				y: y + chartHeight - barHeight,
				width: barWidth,
				height: barHeight,
				radius: 12,
			}),
		);
	});
}

function drawSimpleCard({
	ctx,
	width,
	height,
	label,
	secondary,
	labelFontFamily,
	secondaryFontFamily,
	accent,
	background,
	foreground,
	template,
	progress,
	count,
	localTime,
	textMotion,
	motionProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	secondary: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	template: string;
	progress: number;
	count: number;
	localTime: number;
	textMotion: TextMotion;
	motionProgress: number;
	outProgress: number;
}) {
	const x = width * 0.19;
	const y = height * 0.2;
	const cardWidth = width * 0.62;
	const cardHeight = height * 0.48;
	const cardPath = roundRect({
		x,
		y,
		width: cardWidth,
		height: cardHeight,
		radius: 28,
	});
	ctx.fillStyle = background;
	ctx.shadowColor = "#00000088";
	ctx.shadowBlur = 20;
	ctx.fill(cardPath);
	ctx.shadowBlur = 0;
	ctx.strokeStyle = accent;
	ctx.lineWidth = 4;
	ctx.stroke(cardPath);
	if (template === "loading-ring" || template === "countdown") {
		ctx.strokeStyle = accent;
		ctx.lineWidth = 16;
		ctx.beginPath();
		ctx.arc(
			width / 2,
			y + cardHeight * 0.42,
			cardHeight * 0.18,
			-Math.PI / 2,
			-Math.PI / 2 +
				Math.PI *
					2 *
					((progress / 100) * motionProgress +
						localTime * 0.2 * (1 - outProgress)),
		);
		ctx.stroke();
	}
	if (template === "toggle-switch") {
		const switchWidth = cardWidth * 0.42;
		const switchHeight = cardHeight * 0.2;
		const switchX = width / 2 - switchWidth / 2;
		const switchY = y + cardHeight * 0.42;
		ctx.fillStyle = progress >= 50 ? accent : `${foreground}33`;
		ctx.fill(
			roundRect({
				x: switchX,
				y: switchY,
				width: switchWidth,
				height: switchHeight,
				radius: switchHeight / 2,
			}),
		);
		ctx.fillStyle = foreground;
		ctx.beginPath();
		ctx.arc(
			switchX +
				(progress >= 50 ? switchWidth - switchHeight / 2 : switchHeight / 2),
			switchY + switchHeight / 2,
			switchHeight * 0.36,
			0,
			Math.PI * 2,
		);
		ctx.fill();
	}
	if (template === "rating-stars") {
		ctx.fillStyle = accent;
		setCanvasFont({
			ctx,
			weight: 700,
			size: 46,
			fontFamily: labelFontFamily,
		});
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(
			"*****".slice(
				0,
				Math.max(1, Math.min(5, Math.round(count * motionProgress))),
			),
			width / 2,
			y + cardHeight * 0.42,
		);
	}
	drawCenteredText({
		ctx,
		text: label,
		x: width / 2,
		y: y + cardHeight * 0.72,
		maxWidth: cardWidth * 0.78,
		size: 38,
		color: foreground,
		fontFamily: labelFontFamily,
		motion: textMotion,
	});
	drawCenteredText({
		ctx,
		text: secondary,
		x: width / 2,
		y: y + cardHeight * 0.86,
		maxWidth: cardWidth * 0.72,
		size: 22,
		color: `${foreground}cc`,
		fontFamily: secondaryFontFamily,
		weight: 600,
		motion: textMotion,
	});
}

function drawBatteryDrain({
	ctx,
	width,
	height,
	label,
	secondary,
	labelFontFamily,
	secondaryFontFamily,
	accent,
	background,
	foreground,
	progress,
	batteryMode,
	intensity,
	localTime,
	duration,
	textMotion,
	motionProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	secondary: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	progress: number;
	batteryMode: "charge" | "drain";
	intensity: number;
	localTime: number;
	duration?: number;
	textMotion: TextMotion;
	motionProgress: number;
	outProgress: number;
}) {
	const centerX = width / 2;
	const centerY = height / 2;
	const bodyHeight = Math.min(height * 0.62, width * 0.36);
	const bodyWidth = bodyHeight * 0.38;
	const bodyX = centerX - bodyWidth / 2;
	const bodyY = centerY - bodyHeight * 0.47;
	const radius = bodyWidth * 0.16;
	const terminalWidth = bodyWidth * 0.44;
	const terminalHeight = bodyHeight * 0.06;
	const terminalX = centerX - terminalWidth / 2;
	const terminalY = bodyY - terminalHeight - bodyHeight * 0.025;
	const modePhase =
		duration && duration > 0
			? clampValue({ value: localTime / duration, min: 0, max: 1 })
			: (localTime * 0.16) % 1;
	const baseLevel = clampValue({ value: progress / 100, min: 0, max: 1 });
	const animatedLevel =
		batteryMode === "charge"
			? baseLevel + (1 - baseLevel) * modePhase
			: baseLevel * (1 - modePhase);
	const visibleLevel = clampValue({
		value: animatedLevel * motionProgress * (1 - outProgress * 0.9),
		min: 0,
		max: 1,
	});
	const levelPercent = Math.round(visibleLevel * 100);
	const pulse =
		0.76 +
		Math.sin(localTime * Math.PI * 2 * (batteryMode === "charge" ? 1.4 : 0.8)) *
			0.12 *
			intensity;
	const isCritical = visibleLevel < 0.18 && batteryMode === "drain";
	const isWarning = visibleLevel < 0.42 && batteryMode === "drain";
	const levelColor = isCritical ? "#FF4D6D" : isWarning ? "#FFE66D" : accent;
	const glowColor = batteryMode === "charge" ? accent : levelColor;
	const normalizedSecondary = secondary.trim().toUpperCase();
	const modeStatus = batteryMode === "charge" ? "CHARGING" : "DRAINING";
	const statusText =
		normalizedSecondary === "" ||
		normalizedSecondary === "CHARGING" ||
		normalizedSecondary === "DRAINING"
			? modeStatus
			: secondary;
	const bodyPath = roundRect({
		x: bodyX,
		y: bodyY,
		width: bodyWidth,
		height: bodyHeight,
		radius,
	});
	const glassGradient = ctx.createLinearGradient(
		bodyX,
		bodyY,
		bodyX + bodyWidth,
		bodyY + bodyHeight,
	);
	glassGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.2 }));
	glassGradient.addColorStop(
		0.36,
		withAlpha({ color: background, alpha: 0.3 }),
	);
	glassGradient.addColorStop(1, withAlpha({ color: "#020607", alpha: 0.36 }));

	ctx.save();
	ctx.globalAlpha *= 0.95;
	ctx.shadowColor = withAlpha({
		color: glowColor,
		alpha: 0.28 + intensity * 0.18,
	});
	ctx.shadowBlur = bodyWidth * (0.34 + intensity * 0.35);
	ctx.fillStyle = withAlpha({
		color: glowColor,
		alpha: 0.08 + intensity * 0.06,
	});
	ctx.fill(
		roundRect({
			x: bodyX - bodyWidth * 0.22,
			y: terminalY - bodyHeight * 0.03,
			width: bodyWidth * 1.44,
			height: bodyHeight * 1.12,
			radius: radius * 2,
		}),
	);
	ctx.restore();

	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.36)";
	ctx.shadowBlur = 22;
	ctx.fillStyle = glassGradient;
	ctx.fill(bodyPath);
	ctx.restore();

	ctx.save();
	ctx.strokeStyle = withAlpha({ color: "#ffffff", alpha: 0.22 });
	ctx.lineWidth = 1.4;
	ctx.stroke(
		roundRect({
			x: bodyX + 2,
			y: bodyY + 2,
			width: bodyWidth - 4,
			height: bodyHeight - 4,
			radius: Math.max(4, radius - 2),
		}),
	);
	ctx.shadowColor = withAlpha({ color: glowColor, alpha: 0.68 });
	ctx.shadowBlur = 13 + 20 * intensity * pulse;
	ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.84 });
	ctx.lineWidth = 2.4;
	ctx.stroke(bodyPath);
	ctx.fillStyle = withAlpha({ color: background, alpha: 0.46 });
	ctx.fill(
		roundRect({
			x: terminalX,
			y: terminalY,
			width: terminalWidth,
			height: terminalHeight,
			radius: terminalHeight * 0.35,
		}),
	);
	ctx.stroke(
		roundRect({
			x: terminalX,
			y: terminalY,
			width: terminalWidth,
			height: terminalHeight,
			radius: terminalHeight * 0.35,
		}),
	);
	ctx.restore();

	const innerX = bodyX + bodyWidth * 0.15;
	const innerY = bodyY + bodyHeight * 0.11;
	const innerWidth = bodyWidth * 0.7;
	const innerHeight = bodyHeight * 0.72;
	const segments = 8;
	const segmentGap = bodyHeight * 0.012;
	const segmentHeight =
		(innerHeight - segmentGap * Math.max(0, segments - 1)) / segments;
	const fillGradient = ctx.createLinearGradient(
		innerX,
		innerY + innerHeight,
		innerX,
		innerY,
	);
	fillGradient.addColorStop(0, withAlpha({ color: levelColor, alpha: 0.62 }));
	fillGradient.addColorStop(0.55, withAlpha({ color: levelColor, alpha: 0.9 }));
	fillGradient.addColorStop(1, withAlpha({ color: "#ffffff", alpha: 0.9 }));

	ctx.save();
	ctx.shadowColor = withAlpha({ color: glowColor, alpha: 0.45 });
	ctx.shadowBlur = 10 + intensity * 16;
	for (let index = 0; index < segments; index++) {
		const bottomIndex = segments - 1 - index;
		const segmentY = innerY + index * (segmentHeight + segmentGap);
		const fillAmount = clampValue({
			value: visibleLevel * segments - bottomIndex,
			min: 0,
			max: 1,
		});
		const segmentPath = roundRect({
			x: innerX,
			y: segmentY,
			width: innerWidth,
			height: segmentHeight,
			radius: Math.max(3, segmentHeight * 0.28),
		});
		ctx.fillStyle = withAlpha({ color: foreground, alpha: 0.08 });
		ctx.fill(segmentPath);
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.12 });
		ctx.lineWidth = 1;
		ctx.stroke(segmentPath);
		if (fillAmount <= 0) continue;
		ctx.save();
		ctx.clip(segmentPath);
		ctx.globalAlpha *= 0.82 + pulse * 0.18;
		ctx.fillStyle = fillGradient;
		ctx.fillRect(
			innerX,
			segmentY + segmentHeight * (1 - fillAmount),
			innerWidth,
			segmentHeight * fillAmount,
		);
		ctx.restore();
	}
	ctx.restore();

	const scanY =
		innerY + ((localTime * (batteryMode === "charge" ? 92 : 46)) % innerHeight);
	ctx.save();
	ctx.strokeStyle = withAlpha({
		color: accent,
		alpha: 0.22 + intensity * 0.16,
	});
	ctx.lineWidth = 1.2;
	ctx.beginPath();
	ctx.moveTo(innerX - bodyWidth * 0.08, scanY);
	ctx.lineTo(innerX + innerWidth + bodyWidth * 0.08, scanY);
	ctx.stroke();
	ctx.restore();

	ctx.save();
	ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.2 });
	ctx.lineWidth = 1.2;
	for (let index = 0; index < 9; index++) {
		const tickY = innerY + (innerHeight / 8) * index;
		const tickWidth = index % 2 === 0 ? bodyWidth * 0.18 : bodyWidth * 0.1;
		ctx.beginPath();
		ctx.moveTo(bodyX - tickWidth, tickY);
		ctx.lineTo(bodyX - bodyWidth * 0.05, tickY);
		ctx.moveTo(bodyX + bodyWidth + bodyWidth * 0.05, tickY);
		ctx.lineTo(bodyX + bodyWidth + tickWidth, tickY);
		ctx.stroke();
	}
	ctx.setLineDash([bodyWidth * 0.06, bodyWidth * 0.045]);
	ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.36 });
	ctx.strokeRect(
		bodyX - bodyWidth * 0.34,
		bodyY + bodyHeight * 0.1,
		bodyWidth * 1.68,
		bodyHeight * 0.8,
	);
	ctx.restore();

	if (batteryMode === "charge") {
		const boltX = centerX;
		const boltY = bodyY + bodyHeight * 0.36;
		ctx.save();
		ctx.fillStyle = withAlpha({ color: "#ffffff", alpha: 0.78 });
		ctx.shadowColor = withAlpha({ color: accent, alpha: 0.78 });
		ctx.shadowBlur = 18 + intensity * 16;
		ctx.beginPath();
		ctx.moveTo(boltX + bodyWidth * 0.08, boltY - bodyHeight * 0.16);
		ctx.lineTo(boltX - bodyWidth * 0.06, boltY + bodyHeight * 0.02);
		ctx.lineTo(boltX + bodyWidth * 0.06, boltY + bodyHeight * 0.02);
		ctx.lineTo(boltX - bodyWidth * 0.08, boltY + bodyHeight * 0.2);
		ctx.lineTo(boltX + bodyWidth * 0.02, boltY + bodyHeight * 0.05);
		ctx.lineTo(boltX - bodyWidth * 0.1, boltY + bodyHeight * 0.05);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	drawSevenSegmentText({
		ctx,
		text: String(levelPercent).padStart(2, "0"),
		x: centerX,
		y: bodyY + bodyHeight * 0.56,
		height: Math.min(bodyWidth * 0.36, innerWidth * 0.47),
		color: foreground,
		alpha: 0.82,
	});
	ctx.save();
	ctx.shadowColor = withAlpha({ color: foreground, alpha: 0.45 });
	ctx.shadowBlur = 9;
	ctx.fillStyle = withAlpha({ color: foreground, alpha: 0.78 });
	setCanvasFont({
		ctx,
		weight: 700,
		size: Math.max(12, bodyWidth * 0.1),
		fontFamily: secondaryFontFamily,
	});
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	ctx.fillText("%", centerX + bodyWidth * 0.28, bodyY + bodyHeight * 0.57);
	ctx.restore();

	drawCenteredText({
		ctx,
		text: label,
		x: centerX,
		y: terminalY - bodyHeight * 0.085,
		maxWidth: bodyWidth * 2.8,
		size: Math.max(20, bodyWidth * 0.22),
		color: foreground,
		fontFamily: labelFontFamily,
		weight: 800,
		motion: { ...textMotion, order: 0, total: 2 },
	});
	drawCenteredText({
		ctx,
		text: statusText,
		x: centerX,
		y: bodyY + bodyHeight * 1.08,
		maxWidth: bodyWidth * 3.1,
		size: Math.max(14, bodyWidth * 0.13),
		color: isCritical ? "#FF4D6D" : accent,
		fontFamily: secondaryFontFamily,
		weight: 700,
		motion: { ...textMotion, order: 1, total: 2 },
	});
}

function polygonPath({
	centerX,
	centerY,
	radius,
	sides,
	rotation = 0,
}: {
	centerX: number;
	centerY: number;
	radius: number;
	sides: number;
	rotation?: number;
}): Path2D {
	const path = new Path2D();
	for (let index = 0; index < sides; index++) {
		const angle = rotation + (Math.PI * 2 * index) / sides;
		const x = centerX + Math.cos(angle) * radius;
		const y = centerY + Math.sin(angle) * radius;
		if (index === 0) path.moveTo(x, y);
		else path.lineTo(x, y);
	}
	path.closePath();
	return path;
}

function drawHudGlassRect({
	ctx,
	x,
	y,
	width,
	height,
	radius,
	accent,
	background,
	intensity,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
	accent: string;
	background: string;
	intensity: number;
}) {
	const path = roundRect({ x, y, width, height, radius });
	const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
	gradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.18 }));
	gradient.addColorStop(0.42, withAlpha({ color: background, alpha: 0.3 }));
	gradient.addColorStop(1, withAlpha({ color: "#020608", alpha: 0.36 }));

	ctx.save();
	ctx.shadowColor = withAlpha({ color: accent, alpha: 0.2 + intensity * 0.22 });
	ctx.shadowBlur = 18 + intensity * 28;
	ctx.fillStyle = gradient;
	ctx.fill(path);
	ctx.restore();

	ctx.save();
	ctx.strokeStyle = withAlpha({ color: "#ffffff", alpha: 0.16 });
	ctx.lineWidth = 1.2;
	ctx.stroke(
		roundRect({
			x: x + 2,
			y: y + 2,
			width: width - 4,
			height: height - 4,
			radius: Math.max(2, radius - 2),
		}),
	);
	ctx.shadowColor = withAlpha({ color: accent, alpha: 0.58 });
	ctx.shadowBlur = 11 + intensity * 16;
	ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.82 });
	ctx.lineWidth = 2;
	ctx.stroke(path);
	ctx.restore();
}

function drawNeoHudLabels({
	ctx,
	centerX,
	topY,
	bottomY,
	maxWidth,
	label,
	secondary,
	labelFontFamily,
	secondaryFontFamily,
	foreground,
	accent,
	textMotion,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	centerX: number;
	topY: number;
	bottomY: number;
	maxWidth: number;
	label: string;
	secondary: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	foreground: string;
	accent: string;
	textMotion: TextMotion;
}) {
	drawCenteredText({
		ctx,
		text: label,
		x: centerX,
		y: topY,
		maxWidth,
		size: 34,
		color: foreground,
		fontFamily: labelFontFamily,
		weight: 800,
		motion: { ...textMotion, order: 0, total: 2 },
	});
	drawCenteredText({
		ctx,
		text: secondary,
		x: centerX,
		y: bottomY,
		maxWidth,
		size: 20,
		color: accent,
		fontFamily: secondaryFontFamily,
		weight: 700,
		motion: { ...textMotion, order: 1, total: 2 },
	});
}

function drawArcArrow({
	ctx,
	centerX,
	centerY,
	radius,
	startAngle,
	endAngle,
	color,
	alpha,
	lineWidth,
	clockwise = true,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	centerX: number;
	centerY: number;
	radius: number;
	startAngle: number;
	endAngle: number;
	color: string;
	alpha: number;
	lineWidth: number;
	clockwise?: boolean;
}) {
	const tipX = centerX + Math.cos(endAngle) * radius;
	const tipY = centerY + Math.sin(endAngle) * radius;
	const heading = endAngle + (clockwise ? Math.PI / 2 : -Math.PI / 2);
	const headSize = lineWidth * 3.4;
	const wing = headSize * 0.46;
	const backX = tipX - Math.cos(heading) * headSize;
	const backY = tipY - Math.sin(heading) * headSize;
	const normalX = Math.cos(heading + Math.PI / 2);
	const normalY = Math.sin(heading + Math.PI / 2);

	ctx.save();
	ctx.globalAlpha *= alpha;
	ctx.shadowColor = color;
	ctx.shadowBlur = lineWidth * 4;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius, startAngle, endAngle, !clockwise);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(tipX, tipY);
	ctx.lineTo(backX + normalX * wing, backY + normalY * wing);
	ctx.lineTo(backX - normalX * wing, backY - normalY * wing);
	ctx.closePath();
	ctx.fill();
	ctx.restore();
}

function drawDoubleHeadArrow({
	ctx,
	centerX,
	centerY,
	length,
	angle,
	color,
	alpha,
	lineWidth,
	progress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	centerX: number;
	centerY: number;
	length: number;
	angle: number;
	color: string;
	alpha: number;
	lineWidth: number;
	progress: number;
}) {
	const visibleLength =
		length * clampValue({ value: progress, min: 0, max: 1 });
	const halfLength = visibleLength / 2;
	const unitX = Math.cos(angle);
	const unitY = Math.sin(angle);
	const normalX = Math.cos(angle + Math.PI / 2);
	const normalY = Math.sin(angle + Math.PI / 2);
	const headSize = Math.max(lineWidth * 3.2, length * 0.055);
	const wing = headSize * 0.48;
	const startX = centerX - unitX * halfLength;
	const startY = centerY - unitY * halfLength;
	const endX = centerX + unitX * halfLength;
	const endY = centerY + unitY * halfLength;

	ctx.save();
	ctx.globalAlpha *= alpha;
	ctx.shadowColor = color;
	ctx.shadowBlur = lineWidth * 4.5;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.moveTo(startX, startY);
	ctx.lineTo(endX, endY);
	ctx.stroke();

	for (const direction of [-1, 1]) {
		const tipX = centerX + unitX * halfLength * direction;
		const tipY = centerY + unitY * halfLength * direction;
		const baseX = tipX - unitX * headSize * direction;
		const baseY = tipY - unitY * headSize * direction;
		ctx.beginPath();
		ctx.moveTo(tipX, tipY);
		ctx.lineTo(baseX + normalX * wing, baseY + normalY * wing);
		ctx.lineTo(baseX - normalX * wing, baseY - normalY * wing);
		ctx.closePath();
		ctx.fill();
	}
	ctx.restore();
}

function drawDirectionCrossArrows({
	ctx,
	width,
	height,
	accent,
	background,
	foreground,
	progress,
	intensity,
	localTime,
	motionProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	accent: string;
	background: string;
	foreground: string;
	progress: number;
	intensity: number;
	localTime: number;
	motionProgress: number;
	outProgress: number;
}) {
	const centerX = width / 2;
	const centerY = height / 2;
	const shortSide = Math.min(width, height);
	const length = Math.min(width * 0.54, height * 0.68, shortSide * 0.72);
	const level = clampValue({
		value: (progress / 100) * motionProgress * (1 - outProgress * 0.86),
		min: 0,
		max: 1,
	});
	const pulse =
		0.88 +
		Math.sin(localTime * Math.PI * 2 * (0.38 + intensity * 0.5)) *
			0.12 *
			intensity;
	const secondaryColor =
		foreground === "#ffffff" || foreground === "#fff" ? "#DDF8FF" : foreground;
	const radius = shortSide * 0.1;

	ctx.save();
	ctx.globalAlpha *= 0.9;
	ctx.shadowColor = withAlpha({
		color: accent,
		alpha: 0.18 + intensity * 0.24,
	});
	ctx.shadowBlur = shortSide * (0.06 + intensity * 0.08);
	ctx.fillStyle = withAlpha({ color: accent, alpha: 0.05 + intensity * 0.04 });
	ctx.beginPath();
	ctx.arc(centerX, centerY, length * 0.46, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();

	ctx.save();
	const nodeGradient = ctx.createRadialGradient(
		centerX - radius * 0.3,
		centerY - radius * 0.32,
		radius * 0.08,
		centerX,
		centerY,
		radius,
	);
	nodeGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.18 }));
	nodeGradient.addColorStop(
		0.48,
		withAlpha({ color: background, alpha: 0.24 }),
	);
	nodeGradient.addColorStop(1, withAlpha({ color: accent, alpha: 0.1 }));
	ctx.shadowColor = withAlpha({ color: accent, alpha: 0.32 });
	ctx.shadowBlur = radius * 0.9;
	ctx.fillStyle = nodeGradient;
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * (0.72 + pulse * 0.08), 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();

	ctx.save();
	ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.22 });
	ctx.lineWidth = 1.3;
	ctx.setLineDash([shortSide * 0.018, shortSide * 0.018]);
	ctx.beginPath();
	ctx.arc(centerX, centerY, length * 0.36, 0, Math.PI * 2 * level);
	ctx.stroke();
	ctx.restore();

	drawDoubleHeadArrow({
		ctx,
		centerX,
		centerY,
		length,
		angle: -Math.PI / 4,
		color: accent,
		alpha: 0.88,
		lineWidth: Math.max(3, shortSide * 0.009),
		progress: level,
	});
	drawDoubleHeadArrow({
		ctx,
		centerX,
		centerY,
		length: length * 0.9,
		angle: Math.PI / 4,
		color: secondaryColor,
		alpha: 0.72,
		lineWidth: Math.max(2.4, shortSide * 0.007),
		progress: level,
	});

	for (let index = 0; index < 4; index++) {
		const angle = Math.PI / 4 + (Math.PI / 2) * index;
		const distance = length * 0.47 * level;
		const glintX = centerX + Math.cos(angle) * distance;
		const glintY = centerY + Math.sin(angle) * distance;
		const glintColor = index % 2 === 0 ? accent : secondaryColor;
		ctx.save();
		ctx.globalAlpha *= 0.5 + Math.abs(Math.sin(localTime * 2.2 + index)) * 0.3;
		ctx.translate(glintX, glintY);
		ctx.rotate(angle + Math.PI / 4);
		ctx.shadowColor = glintColor;
		ctx.shadowBlur = 10 + intensity * 12;
		ctx.fillStyle = glintColor;
		const size = Math.max(4, shortSide * 0.012);
		ctx.beginPath();
		ctx.moveTo(0, -size);
		ctx.lineTo(size * 0.42, 0);
		ctx.lineTo(0, size);
		ctx.lineTo(-size * 0.42, 0);
		ctx.closePath();
		ctx.fill();
		ctx.restore();
	}

	ctx.save();
	ctx.shadowColor = withAlpha({ color: accent, alpha: 0.62 });
	ctx.shadowBlur = 10 + intensity * 12;
	ctx.strokeStyle = withAlpha({ color: "#ffffff", alpha: 0.34 });
	ctx.lineWidth = 1.4;
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * 0.34, 0, Math.PI * 2);
	ctx.stroke();
	ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.72 });
	ctx.beginPath();
	ctx.arc(
		centerX,
		centerY,
		radius * 0.56,
		-Math.PI / 2 + localTime * 0.5,
		-Math.PI / 2 + localTime * 0.5 + Math.PI * 1.35 * level,
	);
	ctx.stroke();
	ctx.restore();
}

function drawNeoHudGraphic({
	ctx,
	width,
	height,
	template,
	label,
	secondary,
	labelFontFamily,
	secondaryFontFamily,
	accent,
	background,
	foreground,
	progress,
	intensity,
	localTime,
	duration,
	textMotion,
	motionProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	template: string;
	label: string;
	secondary: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	progress: number;
	intensity: number;
	localTime: number;
	duration?: number;
	textMotion: TextMotion;
	motionProgress: number;
	outProgress: number;
}) {
	const centerX = width / 2;
	const centerY = height / 2;
	const phase =
		duration && duration > 0
			? clampValue({ value: localTime / duration, min: 0, max: 1 })
			: (localTime * 0.18) % 1;
	const level = clampValue({
		value: (progress / 100) * motionProgress * (1 - outProgress * 0.88),
		min: 0,
		max: 1,
	});
	const pulse =
		0.86 +
		Math.sin(localTime * Math.PI * 2 * (0.7 + intensity * 0.6)) *
			0.11 *
			intensity;
	const size = Math.min(width, height) * 0.54;
	const radius = size / 2;

	if (template === "hud-radar-sweep") {
		const ringRadius = radius * 0.72;
		const glassGradient = ctx.createRadialGradient(
			centerX - ringRadius * 0.35,
			centerY - ringRadius * 0.35,
			ringRadius * 0.08,
			centerX,
			centerY,
			ringRadius,
		);
		glassGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.2 }));
		glassGradient.addColorStop(
			0.42,
			withAlpha({ color: background, alpha: 0.28 }),
		);
		glassGradient.addColorStop(1, withAlpha({ color: "#020807", alpha: 0.34 }));

		ctx.save();
		ctx.shadowColor = withAlpha({
			color: accent,
			alpha: 0.28 + intensity * 0.18,
		});
		ctx.shadowBlur = ringRadius * (0.32 + intensity * 0.24);
		ctx.fillStyle = withAlpha({ color: accent, alpha: 0.08 });
		ctx.beginPath();
		ctx.arc(centerX, centerY, ringRadius * 1.12, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		ctx.save();
		ctx.fillStyle = glassGradient;
		ctx.beginPath();
		ctx.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.32 });
		ctx.lineWidth = 1.4;
		for (let index = 1; index <= 4; index++) {
			ctx.beginPath();
			ctx.arc(centerX, centerY, (ringRadius * index) / 4, 0, Math.PI * 2);
			ctx.stroke();
		}
		for (let index = 0; index < 8; index++) {
			const angle = (Math.PI * 2 * index) / 8;
			ctx.beginPath();
			ctx.moveTo(centerX, centerY);
			ctx.lineTo(
				centerX + Math.cos(angle) * ringRadius,
				centerY + Math.sin(angle) * ringRadius,
			);
			ctx.stroke();
		}
		ctx.restore();

		const sweepAngle = localTime * Math.PI * 2 * (0.35 + intensity * 0.32);
		ctx.save();
		ctx.translate(centerX, centerY);
		ctx.rotate(sweepAngle);
		const sweepGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ringRadius);
		sweepGradient.addColorStop(0, withAlpha({ color: accent, alpha: 0.12 }));
		sweepGradient.addColorStop(1, withAlpha({ color: accent, alpha: 0.4 }));
		ctx.fillStyle = sweepGradient;
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.arc(0, 0, ringRadius * level, -0.08, 0.42);
		ctx.closePath();
		ctx.fill();
		ctx.shadowColor = withAlpha({ color: accent, alpha: 0.72 });
		ctx.shadowBlur = 12 + intensity * 14;
		ctx.strokeStyle = accent;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.lineTo(ringRadius * level, 0);
		ctx.stroke();
		ctx.restore();

		const blips = [
			{ x: -0.34, y: -0.18 },
			{ x: 0.28, y: -0.34 },
			{ x: 0.4, y: 0.2 },
			{ x: -0.12, y: 0.38 },
		];
		blips.forEach((blip, index) => {
			const blipAlpha =
				0.22 +
				Math.abs(Math.sin(localTime * 3.2 + index * 0.9)) *
					(0.45 + intensity * 0.28);
			ctx.save();
			ctx.globalAlpha *= index / blips.length <= level ? blipAlpha : 0.12;
			ctx.shadowColor = accent;
			ctx.shadowBlur = 14;
			ctx.fillStyle = foreground;
			ctx.beginPath();
			ctx.arc(
				centerX + blip.x * ringRadius,
				centerY + blip.y * ringRadius,
				4 + intensity * 4,
				0,
				Math.PI * 2,
			);
			ctx.fill();
			ctx.restore();
		});

		drawSevenSegmentText({
			ctx,
			text: String(Math.round(level * 99)).padStart(2, "0"),
			x: centerX,
			y: centerY,
			height: ringRadius * 0.25,
			color: foreground,
			alpha: 0.74,
		});
		drawNeoHudLabels({
			ctx,
			centerX,
			topY: centerY - ringRadius * 1.24,
			bottomY: centerY + ringRadius * 1.24,
			maxWidth: ringRadius * 2.3,
			label,
			secondary,
			labelFontFamily,
			secondaryFontFamily,
			foreground,
			accent,
			textMotion,
		});
		return;
	}

	if (template === "hud-target-lock") {
		const lockSize = size * 0.72;
		const x = centerX - lockSize / 2;
		const y = centerY - lockSize / 2;
		const inset = (1 - level) * lockSize * 0.1;

		drawHudGlassRect({
			ctx,
			x,
			y,
			width: lockSize,
			height: lockSize,
			radius: lockSize * 0.06,
			accent,
			background,
			intensity,
		});

		ctx.save();
		ctx.translate(centerX, centerY);
		ctx.rotate(localTime * 0.32);
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.42 });
		ctx.lineWidth = 2;
		ctx.stroke(
			polygonPath({
				centerX: 0,
				centerY: 0,
				radius: lockSize * 0.34,
				sides: 4,
				rotation: Math.PI / 4,
			}),
		);
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.24 });
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.moveTo(centerX - lockSize * 0.36, centerY);
		ctx.lineTo(centerX + lockSize * 0.36, centerY);
		ctx.moveTo(centerX, centerY - lockSize * 0.36);
		ctx.lineTo(centerX, centerY + lockSize * 0.36);
		ctx.stroke();
		ctx.restore();

		ctx.save();
		ctx.shadowColor = withAlpha({ color: accent, alpha: 0.8 });
		ctx.shadowBlur = 12 + intensity * 18;
		ctx.strokeStyle = accent;
		ctx.lineWidth = 3;
		const corner = lockSize * 0.18;
		const left = x + inset;
		const right = x + lockSize - inset;
		const top = y + inset;
		const bottom = y + lockSize - inset;
		ctx.beginPath();
		ctx.moveTo(left, top + corner);
		ctx.lineTo(left, top);
		ctx.lineTo(left + corner, top);
		ctx.moveTo(right - corner, top);
		ctx.lineTo(right, top);
		ctx.lineTo(right, top + corner);
		ctx.moveTo(right, bottom - corner);
		ctx.lineTo(right, bottom);
		ctx.lineTo(right - corner, bottom);
		ctx.moveTo(left + corner, bottom);
		ctx.lineTo(left, bottom);
		ctx.lineTo(left, bottom - corner);
		ctx.stroke();
		ctx.beginPath();
		ctx.arc(
			centerX,
			centerY,
			lockSize * 0.24,
			-Math.PI / 2,
			-Math.PI / 2 + Math.PI * 2 * level,
		);
		ctx.stroke();
		ctx.restore();

		drawSevenSegmentText({
			ctx,
			text: String(Math.round(level * 100)).padStart(2, "0"),
			x: centerX,
			y: centerY,
			height: lockSize * 0.14,
			color: foreground,
			alpha: 0.82,
		});
		drawNeoHudLabels({
			ctx,
			centerX,
			topY: y - lockSize * 0.16,
			bottomY: y + lockSize * 1.16,
			maxWidth: lockSize * 1.25,
			label,
			secondary,
			labelFontFamily,
			secondaryFontFamily,
			foreground,
			accent,
			textMotion,
		});
		return;
	}

	if (template === "hud-signal-scanner") {
		const panelWidth = width * 0.58;
		const panelHeight = height * 0.34;
		const x = centerX - panelWidth / 2;
		const y = centerY - panelHeight / 2;
		drawHudGlassRect({
			ctx,
			x,
			y,
			width: panelWidth,
			height: panelHeight,
			radius: 22,
			accent,
			background,
			intensity,
		});

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.1 });
		ctx.lineWidth = 1;
		for (let index = 1; index < 5; index++) {
			const gridY = y + (panelHeight * index) / 5;
			ctx.beginPath();
			ctx.moveTo(x + panelWidth * 0.08, gridY);
			ctx.lineTo(x + panelWidth * 0.92, gridY);
			ctx.stroke();
		}
		ctx.restore();

		const barCount = 14;
		const barGap = panelWidth * 0.012;
		const barWidth = (panelWidth * 0.58 - barGap * (barCount - 1)) / barCount;
		const barBaseX = x + panelWidth * 0.12;
		const barBaseY = y + panelHeight * 0.72;
		for (let index = 0; index < barCount; index++) {
			const normalized = index / Math.max(1, barCount - 1);
			const wave =
				0.18 +
				Math.abs(Math.sin(localTime * 4 + index * 0.62)) *
					(0.32 + intensity * 0.24) +
				level * 0.32;
			const barHeight =
				panelHeight * clampValue({ value: wave, min: 0.08, max: 0.82 });
			const barX = barBaseX + index * (barWidth + barGap);
			ctx.save();
			ctx.globalAlpha *= normalized <= level ? 0.88 : 0.2;
			ctx.shadowColor = accent;
			ctx.shadowBlur = 10 + intensity * 10;
			ctx.fillStyle =
				normalized <= level
					? accent
					: withAlpha({ color: foreground, alpha: 0.2 });
			ctx.fill(
				roundRect({
					x: barX,
					y: barBaseY - barHeight,
					width: barWidth,
					height: barHeight,
					radius: barWidth / 2,
				}),
			);
			ctx.restore();
		}

		ctx.save();
		ctx.strokeStyle = foreground;
		ctx.shadowColor = accent;
		ctx.shadowBlur = 10 + intensity * 12;
		ctx.lineWidth = 2;
		ctx.beginPath();
		for (let index = 0; index <= 72; index++) {
			const step = index / 72;
			const pointX = x + panelWidth * (0.1 + step * 0.82);
			const pointY =
				y +
				panelHeight * 0.32 +
				Math.sin(step * Math.PI * 6 + localTime * 3.4) *
					panelHeight *
					0.08 *
					(0.35 + intensity);
			if (index === 0) ctx.moveTo(pointX, pointY);
			else ctx.lineTo(pointX, pointY);
		}
		ctx.stroke();
		ctx.restore();

		const scanX =
			x + panelWidth * (0.1 + ((phase + localTime * 0.06) % 1) * 0.82);
		ctx.save();
		ctx.strokeStyle = withAlpha({ color: "#ffffff", alpha: 0.56 });
		ctx.shadowColor = accent;
		ctx.shadowBlur = 18;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(scanX, y + panelHeight * 0.12);
		ctx.lineTo(scanX, y + panelHeight * 0.88);
		ctx.stroke();
		ctx.restore();

		drawNeoHudLabels({
			ctx,
			centerX,
			topY: y - panelHeight * 0.18,
			bottomY: y + panelHeight * 1.18,
			maxWidth: panelWidth,
			label,
			secondary,
			labelFontFamily,
			secondaryFontFamily,
			foreground,
			accent,
			textMotion,
		});
		return;
	}

	if (template === "hud-data-core") {
		const coreRadius = radius * 0.56;
		const outerHex = polygonPath({
			centerX,
			centerY,
			radius: coreRadius * 1.25,
			sides: 6,
			rotation: Math.PI / 6,
		});
		const innerHex = polygonPath({
			centerX,
			centerY,
			radius: coreRadius * 0.82,
			sides: 6,
			rotation: Math.PI / 6 + localTime * 0.18,
		});

		ctx.save();
		ctx.shadowColor = withAlpha({
			color: accent,
			alpha: 0.28 + intensity * 0.22,
		});
		ctx.shadowBlur = 24 + intensity * 26;
		ctx.fillStyle = withAlpha({ color: background, alpha: 0.36 });
		ctx.fill(outerHex);
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.18 });
		ctx.lineWidth = 1.5;
		ctx.stroke(outerHex);
		ctx.shadowColor = accent;
		ctx.shadowBlur = 13 + intensity * 14;
		ctx.strokeStyle = accent;
		ctx.lineWidth = 2.6;
		ctx.stroke(innerHex);
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.34 });
		ctx.lineWidth = 1.4;
		for (let index = 0; index < 3; index++) {
			ctx.beginPath();
			ctx.ellipse(
				centerX,
				centerY,
				coreRadius * (0.84 + index * 0.18),
				coreRadius * (0.28 + index * 0.1),
				localTime * (0.32 + index * 0.09),
				0,
				Math.PI * 2,
			);
			ctx.stroke();
		}
		ctx.restore();

		ctx.save();
		const coreGradient = ctx.createRadialGradient(
			centerX - coreRadius * 0.18,
			centerY - coreRadius * 0.18,
			coreRadius * 0.04,
			centerX,
			centerY,
			coreRadius * 0.48,
		);
		coreGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.88 }));
		coreGradient.addColorStop(0.45, withAlpha({ color: accent, alpha: 0.54 }));
		coreGradient.addColorStop(1, withAlpha({ color: accent, alpha: 0.1 }));
		ctx.shadowColor = accent;
		ctx.shadowBlur = 18 + intensity * 20;
		ctx.fillStyle = coreGradient;
		ctx.beginPath();
		ctx.arc(
			centerX,
			centerY,
			coreRadius * (0.28 + level * 0.08),
			0,
			Math.PI * 2,
		);
		ctx.fill();
		ctx.restore();

		for (let index = 0; index < 6; index++) {
			const angle =
				localTime * (0.75 + intensity * 0.25) + (Math.PI * 2 * index) / 6;
			const nodeRadius = coreRadius * (0.62 + (index % 2) * 0.22);
			ctx.save();
			ctx.globalAlpha *= index / 6 <= level ? 0.92 : 0.22;
			ctx.shadowColor = accent;
			ctx.shadowBlur = 12;
			ctx.fillStyle = index % 2 ? foreground : accent;
			ctx.beginPath();
			ctx.arc(
				centerX + Math.cos(angle) * nodeRadius,
				centerY + Math.sin(angle) * nodeRadius * 0.52,
				4 + intensity * 3,
				0,
				Math.PI * 2,
			);
			ctx.fill();
			ctx.restore();
		}

		drawSevenSegmentText({
			ctx,
			text: String(Math.round(level * 100)).padStart(2, "0"),
			x: centerX,
			y: centerY,
			height: coreRadius * 0.28,
			color: foreground,
			alpha: 0.78,
		});
		drawNeoHudLabels({
			ctx,
			centerX,
			topY: centerY - coreRadius * 1.56,
			bottomY: centerY + coreRadius * 1.56,
			maxWidth: coreRadius * 2.5,
			label,
			secondary,
			labelFontFamily,
			secondaryFontFamily,
			foreground,
			accent,
			textMotion,
		});
		return;
	}

	if (template === "hud-direction-shift") {
		const portalRadius = radius * 0.68;
		const magicColor = "#D77BFF";
		const turn = localTime * (0.5 + intensity * 0.34);
		const arrowSweep = Math.PI * (0.62 + level * 0.7);
		const glassGradient = ctx.createRadialGradient(
			centerX - portalRadius * 0.28,
			centerY - portalRadius * 0.32,
			portalRadius * 0.08,
			centerX,
			centerY,
			portalRadius,
		);
		glassGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.22 }));
		glassGradient.addColorStop(
			0.38,
			withAlpha({ color: background, alpha: 0.32 }),
		);
		glassGradient.addColorStop(0.72, withAlpha({ color: accent, alpha: 0.08 }));
		glassGradient.addColorStop(
			1,
			withAlpha({ color: magicColor, alpha: 0.12 }),
		);

		ctx.save();
		ctx.shadowColor = withAlpha({
			color: magicColor,
			alpha: 0.24 + intensity * 0.28,
		});
		ctx.shadowBlur = portalRadius * (0.38 + intensity * 0.34);
		ctx.fillStyle = withAlpha({
			color: magicColor,
			alpha: 0.08 + pulse * 0.04,
		});
		ctx.beginPath();
		ctx.arc(centerX, centerY, portalRadius * 1.22, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		ctx.save();
		ctx.fillStyle = glassGradient;
		ctx.beginPath();
		ctx.arc(centerX, centerY, portalRadius, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();

		ctx.save();
		ctx.translate(centerX, centerY);
		ctx.rotate(turn * 0.45);
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.14 });
		ctx.lineWidth = 1.2;
		for (let index = 0; index < 3; index++) {
			ctx.beginPath();
			ctx.ellipse(
				0,
				0,
				portalRadius * (0.52 + index * 0.18),
				portalRadius * (0.2 + index * 0.07),
				(index * Math.PI) / 3,
				0,
				Math.PI * 2,
			);
			ctx.stroke();
		}
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.24 });
		ctx.lineWidth = 1.4;
		ctx.setLineDash([portalRadius * 0.08, portalRadius * 0.055]);
		ctx.beginPath();
		ctx.arc(centerX, centerY, portalRadius * 0.9, 0, Math.PI * 2);
		ctx.stroke();
		ctx.setLineDash([portalRadius * 0.035, portalRadius * 0.05]);
		ctx.strokeStyle = withAlpha({ color: magicColor, alpha: 0.28 });
		ctx.beginPath();
		ctx.arc(centerX, centerY, portalRadius * 1.08, 0, Math.PI * 2);
		ctx.stroke();
		ctx.restore();

		drawArcArrow({
			ctx,
			centerX,
			centerY,
			radius: portalRadius * 0.82,
			startAngle: -Math.PI * 0.86 + turn,
			endAngle: -Math.PI * 0.86 + turn + arrowSweep,
			color: accent,
			alpha: 0.88,
			lineWidth: 4.2,
			clockwise: true,
		});
		drawArcArrow({
			ctx,
			centerX,
			centerY,
			radius: portalRadius * 0.64,
			startAngle: Math.PI * 0.14 + turn,
			endAngle: Math.PI * 0.14 + turn - arrowSweep,
			color: magicColor,
			alpha: 0.82,
			lineWidth: 3.4,
			clockwise: false,
		});

		ctx.save();
		ctx.shadowColor = accent;
		ctx.shadowBlur = 14 + intensity * 16;
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.56 });
		ctx.lineWidth = 2;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(centerX - portalRadius * 0.62, centerY);
		ctx.lineTo(centerX + portalRadius * 0.62, centerY);
		ctx.stroke();
		for (const side of [-1, 1]) {
			for (let index = 0; index < 3; index++) {
				const chevronX =
					centerX + side * portalRadius * (0.43 + index * 0.13 + level * 0.04);
				const chevronSize = portalRadius * (0.08 + index * 0.012);
				ctx.strokeStyle =
					side > 0
						? withAlpha({ color: accent, alpha: 0.48 + index * 0.14 })
						: withAlpha({ color: magicColor, alpha: 0.48 + index * 0.14 });
				ctx.beginPath();
				ctx.moveTo(chevronX - side * chevronSize, centerY - chevronSize);
				ctx.lineTo(chevronX, centerY);
				ctx.lineTo(chevronX - side * chevronSize, centerY + chevronSize);
				ctx.stroke();
			}
		}
		ctx.restore();

		for (let index = 0; index < 20; index++) {
			const particleAngle =
				(Math.PI * 2 * index) / 20 + localTime * (0.55 + (index % 3) * 0.08);
			const particleRadius =
				portalRadius * (0.52 + ((index * 7) % 9) * 0.065 + pulse * 0.04);
			const particleX = centerX + Math.cos(particleAngle) * particleRadius;
			const particleY = centerY + Math.sin(particleAngle) * particleRadius;
			const particleSize = 2.2 + ((index * 5) % 4) + intensity * 2.2;
			const particleColor = index % 2 === 0 ? accent : magicColor;
			ctx.save();
			ctx.globalAlpha *=
				0.24 +
				Math.abs(Math.sin(localTime * 2.8 + index * 0.7)) *
					(0.38 + intensity * 0.24);
			ctx.translate(particleX, particleY);
			ctx.rotate(particleAngle + localTime);
			ctx.shadowColor = particleColor;
			ctx.shadowBlur = 10 + intensity * 12;
			ctx.fillStyle = particleColor;
			ctx.beginPath();
			ctx.moveTo(0, -particleSize);
			ctx.lineTo(particleSize * 0.42, 0);
			ctx.lineTo(0, particleSize);
			ctx.lineTo(-particleSize * 0.42, 0);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		}

		drawCenteredText({
			ctx,
			text: label,
			x: centerX,
			y: centerY - portalRadius * 0.1,
			maxWidth: portalRadius * 2.2,
			size: 44,
			color: foreground,
			fontFamily: labelFontFamily,
			weight: 900,
			motion: { ...textMotion, order: 0, total: 2 },
		});
		drawCenteredText({
			ctx,
			text: secondary,
			x: centerX,
			y: centerY + portalRadius * 0.44,
			maxWidth: portalRadius * 2.1,
			size: 18,
			color: accent,
			fontFamily: secondaryFontFamily,
			weight: 700,
			motion: { ...textMotion, order: 1, total: 2 },
		});
		return;
	}

	if (template === "hud-alert-beacon") {
		const beaconRadius = radius * 0.72;
		const triangle = polygonPath({
			centerX,
			centerY: centerY + beaconRadius * 0.08,
			radius: beaconRadius,
			sides: 3,
			rotation: -Math.PI / 2,
		});

		ctx.save();
		ctx.shadowColor = withAlpha({
			color: accent,
			alpha: 0.34 + intensity * 0.26,
		});
		ctx.shadowBlur = 28 + intensity * 28;
		ctx.fillStyle = withAlpha({
			color: background,
			alpha: 0.34 + pulse * 0.08,
		});
		ctx.fill(triangle);
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: foreground, alpha: 0.18 });
		ctx.lineWidth = 1.4;
		ctx.stroke(triangle);
		ctx.shadowColor = accent;
		ctx.shadowBlur = 16 + intensity * 18;
		ctx.strokeStyle = accent;
		ctx.lineWidth = 3.2;
		ctx.stroke(triangle);
		ctx.restore();

		ctx.save();
		ctx.clip(triangle);
		const scanY =
			centerY -
			beaconRadius * 0.62 +
			((localTime * 74) % (beaconRadius * 1.24));
		const scanGradient = ctx.createLinearGradient(
			centerX,
			scanY - beaconRadius * 0.12,
			centerX,
			scanY + beaconRadius * 0.12,
		);
		scanGradient.addColorStop(0, withAlpha({ color: accent, alpha: 0 }));
		scanGradient.addColorStop(0.5, withAlpha({ color: accent, alpha: 0.32 }));
		scanGradient.addColorStop(1, withAlpha({ color: accent, alpha: 0 }));
		ctx.fillStyle = scanGradient;
		ctx.fillRect(
			centerX - beaconRadius,
			scanY - beaconRadius * 0.12,
			beaconRadius * 2,
			beaconRadius * 0.24,
		);
		ctx.restore();

		ctx.save();
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.18 });
		ctx.lineWidth = 1.3;
		for (let index = 1; index <= 3; index++) {
			ctx.beginPath();
			ctx.arc(
				centerX,
				centerY + beaconRadius * 0.08,
				beaconRadius * (0.42 + index * 0.23) * (0.82 + pulse * 0.12),
				0,
				Math.PI * 2,
			);
			ctx.stroke();
		}
		ctx.restore();

		ctx.save();
		ctx.shadowColor = accent;
		ctx.shadowBlur = 16 + intensity * 18;
		ctx.strokeStyle = foreground;
		ctx.lineWidth = beaconRadius * 0.08;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(centerX, centerY - beaconRadius * 0.22);
		ctx.lineTo(centerX, centerY + beaconRadius * 0.18);
		ctx.stroke();
		ctx.fillStyle = foreground;
		ctx.beginPath();
		ctx.arc(
			centerX,
			centerY + beaconRadius * 0.4,
			beaconRadius * 0.055,
			0,
			Math.PI * 2,
		);
		ctx.fill();
		ctx.restore();

		drawSevenSegmentText({
			ctx,
			text: String(Math.round(level * 100)).padStart(2, "0"),
			x: centerX,
			y: centerY + beaconRadius * 0.07,
			height: beaconRadius * 0.18,
			color: foreground,
			alpha: 0.5,
		});
		drawNeoHudLabels({
			ctx,
			centerX,
			topY: centerY - beaconRadius * 1.06,
			bottomY: centerY + beaconRadius * 1.22,
			maxWidth: beaconRadius * 2.2,
			label,
			secondary,
			labelFontFamily,
			secondaryFontFamily,
			foreground,
			accent,
			textMotion,
		});
	}
}

function drawWastedOverlay({
	ctx,
	width,
	height,
	label,
	secondary,
	labelFontFamily,
	secondaryFontFamily,
	accent,
	background,
	foreground,
	screenMode,
	intensity,
	localTime,
	timing,
	animationIn,
	animationOut,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	secondary: string;
	labelFontFamily: string;
	secondaryFontFamily: string;
	accent: string;
	background: string;
	foreground: string;
	screenMode: OverlayScreenMode;
	intensity: number;
	localTime: number;
	timing: UiMotionTiming;
	animationIn: string;
	animationOut: string;
}) {
	const mode = resolveOverlayScreenMode({ value: screenMode, width, height });
	const centerX = width / 2;
	const centerY = height / 2;
	const shortSide = Math.min(width, height);
	const aspect = width / Math.max(1, height);
	const inProgress = timing.inProgress;
	const outProgress = timing.outProgress;
	const visibleProgress = clampValue({
		value: inProgress * (1 - outProgress),
		min: 0,
		max: 1,
	});
	const pulse =
		0.9 +
		Math.sin(localTime * Math.PI * 2 * (0.45 + intensity * 0.45)) *
			0.1 *
			intensity;
	const impact =
		animationIn.includes("flash") ||
		animationIn.includes("smash") ||
		animationIn.includes("burst")
			? Math.sin(inProgress * Math.PI)
			: Math.max(0, 1 - inProgress) * 0.6;
	const redWash = (0.16 + intensity * 0.18 + impact * 0.16) * visibleProgress;
	const darkWash = (0.42 + intensity * 0.24 + impact * 0.18) * visibleProgress;
	const outClear =
		animationOut.includes("clear") || animationOut.includes("drain");
	const titleExitOffset = outClear ? 0 : outProgress * shortSide * 0.08;
	const titleY =
		mode === "vertical"
			? height * 0.48
			: mode === "square"
				? height * 0.49
				: height * 0.52;
	const titleMaxWidth =
		mode === "vertical"
			? width * 0.9
			: mode === "square"
				? width * 0.82
				: width * 0.74;
	const titleBaseSize =
		mode === "vertical"
			? Math.min(width * 0.23, height * 0.12)
			: mode === "square"
				? Math.min(width * 0.17, height * 0.17)
				: Math.min(width * 0.135, height * 0.22);
	const bandHeight =
		mode === "vertical" ? height * 0.12 : Math.max(92, shortSide * 0.14);
	const titleScale =
		(0.78 + easeOutBack(inProgress) * 0.22 + impact * 0.08) *
		(1 - outProgress * 0.12);
	const titleTilt =
		(mode === "vertical" ? -0.01 : -0.018) +
		Math.sin(localTime * 1.7) * 0.004 * intensity;
	const displayLabel = label.trim() || "WASTED";

	ctx.save();
	ctx.globalAlpha *= visibleProgress;
	ctx.fillStyle = withAlpha({ color: background, alpha: darkWash });
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = withAlpha({ color: accent, alpha: redWash });
	ctx.fillRect(0, 0, width, height);
	ctx.restore();

	ctx.save();
	const vignette = ctx.createRadialGradient(
		centerX,
		centerY,
		shortSide * 0.08,
		centerX,
		centerY,
		Math.max(width, height) * 0.68,
	);
	vignette.addColorStop(0, withAlpha({ color: accent, alpha: 0.02 }));
	vignette.addColorStop(
		0.58,
		withAlpha({ color: background, alpha: darkWash * 0.42 }),
	);
	vignette.addColorStop(
		1,
		withAlpha({ color: "#000000", alpha: 0.5 * visibleProgress }),
	);
	ctx.fillStyle = vignette;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();

	ctx.save();
	ctx.globalAlpha *= visibleProgress * (0.5 + intensity * 0.3);
	ctx.translate(centerX, titleY + titleExitOffset);
	ctx.rotate(titleTilt);
	const bandGradient = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);
	bandGradient.addColorStop(0, "rgba(0,0,0,0)");
	bandGradient.addColorStop(0.18, "rgba(0,0,0,0.54)");
	bandGradient.addColorStop(0.5, withAlpha({ color: "#000000", alpha: 0.72 }));
	bandGradient.addColorStop(0.82, "rgba(0,0,0,0.54)");
	bandGradient.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = bandGradient;
	ctx.fillRect(-width * 0.58, -bandHeight / 2, width * 1.16, bandHeight);
	ctx.fillStyle = withAlpha({ color: accent, alpha: 0.18 + impact * 0.12 });
	ctx.fillRect(
		-width * 0.58,
		-bandHeight * 0.04,
		width * 1.16,
		bandHeight * 0.08,
	);
	ctx.restore();

	ctx.save();
	ctx.globalAlpha *= visibleProgress * (0.18 + intensity * 0.16);
	ctx.fillStyle = "#000000";
	const lineGap = Math.max(4, Math.round(shortSide * 0.008));
	for (let y = 0; y < height; y += lineGap) {
		ctx.fillRect(0, y, width, 1);
	}
	ctx.restore();

	ctx.save();
	ctx.globalAlpha *=
		visibleProgress * (0.12 + intensity * 0.16 + impact * 0.08);
	for (let index = 0; index < 90; index++) {
		const seed = Math.sin(index * 91.17 + localTime * 1.3);
		const x = ((Math.abs(seed) * 9973 + index * 37) % 1000) / 1000;
		const y =
			((Math.abs(Math.sin(index * 43.31)) * 7919 + localTime * 12) % 1000) /
			1000;
		const fleckWidth = 1 + ((index * 7) % 9);
		ctx.fillStyle =
			index % 4 === 0
				? withAlpha({ color: accent, alpha: 0.42 })
				: "rgba(255,255,255,0.18)";
		ctx.fillRect(x * width, y * height, fleckWidth, 1);
	}
	ctx.restore();

	ctx.save();
	ctx.translate(centerX, titleY + titleExitOffset);
	ctx.rotate(titleTilt);
	ctx.scale(titleScale, titleScale);
	ctx.globalAlpha *= visibleProgress;
	if (animationIn.includes("glow") || animationIn.includes("flash")) {
		ctx.filter = `blur(${Math.max(0, (1 - inProgress) * 3)}px)`;
	}
	const titleSize = fitText({
		ctx,
		text: displayLabel,
		maxWidth: titleMaxWidth,
		startSize: titleBaseSize,
		minSize: Math.max(34, shortSide * 0.055),
		weight: 900,
		fontFamily: labelFontFamily,
	});
	setCanvasFont({
		ctx,
		weight: 900,
		size: titleSize,
		fontFamily: labelFontFamily,
	});
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.direction = "ltr";
	ctx.lineJoin = "round";
	ctx.shadowColor = "#000000";
	ctx.shadowBlur = titleSize * 0.08;
	ctx.strokeStyle = withAlpha({ color: "#000000", alpha: 0.74 });
	ctx.lineWidth = Math.max(6, titleSize * 0.08);
	ctx.strokeText(displayLabel, 0, 0, titleMaxWidth);
	const titleGradient = ctx.createLinearGradient(
		0,
		-titleSize * 0.55,
		0,
		titleSize * 0.55,
	);
	titleGradient.addColorStop(0, foreground);
	titleGradient.addColorStop(0.45, withAlpha({ color: accent, alpha: 0.95 }));
	titleGradient.addColorStop(1, withAlpha({ color: "#6F0710", alpha: 0.98 }));
	ctx.shadowColor = withAlpha({ color: accent, alpha: 0.74 + impact * 0.2 });
	ctx.shadowBlur = titleSize * (0.14 + intensity * 0.08 + pulse * 0.04);
	ctx.fillStyle = titleGradient;
	ctx.fillText(displayLabel, 0, 0, titleMaxWidth);
	ctx.shadowBlur = 0;
	ctx.globalAlpha *= 0.8;
	ctx.fillStyle = withAlpha({ color: "#ffffff", alpha: 0.22 });
	ctx.fillRect(
		-titleMaxWidth * 0.52,
		-titleSize * 0.08,
		titleMaxWidth * 1.04,
		titleSize * 0.035,
	);
	ctx.restore();

	if (secondary.trim()) {
		drawCenteredText({
			ctx,
			text: secondary,
			x: centerX,
			y:
				titleY +
				titleExitOffset +
				(mode === "vertical" ? bandHeight * 0.72 : bandHeight * 0.66),
			maxWidth: mode === "vertical" ? width * 0.7 : width * 0.42,
			size: mode === "vertical" ? Math.max(18, width * 0.045) : 24,
			color: withAlpha({ color: foreground, alpha: 0.74 }),
			fontFamily: secondaryFontFamily,
			weight: 700,
			motion: {
				...timing.textMotion,
				progress: clampValue({
					value: visibleProgress * 1.2 - 0.2,
					min: 0,
					max: 1,
				}),
			},
		});
	}

	if (animationOut.includes("shatter") && outProgress > 0) {
		drawMotionFragments({
			ctx,
			width,
			height,
			color: accent,
			progress: outProgress,
		});
	}

	if (aspect < 0.7 && mode !== "wide") {
		ctx.save();
		ctx.globalAlpha *= visibleProgress * 0.18;
		ctx.strokeStyle = withAlpha({ color: accent, alpha: 0.34 });
		ctx.lineWidth = 2;
		ctx.strokeRect(width * 0.08, height * 0.08, width * 0.84, height * 0.84);
		ctx.restore();
	}
}

function drawHudCountdown({
	ctx,
	width,
	height,
	label,
	accent,
	background,
	foreground,
	localTime,
	duration,
	progress,
	motionProgress,
	outProgress,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	label: string;
	accent: string;
	background: string;
	foreground: string;
	localTime: number;
	duration?: number;
	progress: number;
	motionProgress: number;
	outProgress: number;
}) {
	const centerX = width / 2;
	const centerY = height / 2;
	const diameter = Math.min(width, height) * 0.31;
	const radius = diameter / 2;
	const pulse = 0.975 + Math.sin(localTime * Math.PI * 2 * 0.65) * 0.025;
	const remaining =
		duration && duration > 0
			? clampValue({ value: 1 - localTime / duration, min: 0, max: 1 })
			: clampValue({ value: progress / 100, min: 0, max: 1 });
	const visibleRemaining = clampValue({
		value: remaining * motionProgress * (1 - outProgress * 0.8),
		min: 0,
		max: 1,
	});
	const ringColor = "#D4FFA4";
	const primaryGlow = accent || "#B6FF73";
	const glassGradient = ctx.createRadialGradient(
		centerX - radius * 0.35,
		centerY - radius * 0.35,
		radius * 0.08,
		centerX,
		centerY,
		radius,
	);
	glassGradient.addColorStop(0, withAlpha({ color: "#ffffff", alpha: 0.2 }));
	glassGradient.addColorStop(
		0.42,
		withAlpha({ color: background, alpha: 0.28 }),
	);
	glassGradient.addColorStop(1, withAlpha({ color: "#07130c", alpha: 0.38 }));

	ctx.save();
	ctx.globalAlpha *= 0.92;
	ctx.shadowColor = "rgba(170,255,120,0.18)";
	ctx.shadowBlur = radius * 0.36;
	ctx.fillStyle = "rgba(170,255,120,0.08)";
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * 1.15, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();

	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.3)";
	ctx.shadowBlur = 18;
	ctx.fillStyle = glassGradient;
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * pulse, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();

	ctx.save();
	ctx.strokeStyle = withAlpha({ color: "#ffffff", alpha: 0.16 });
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * 0.96, 0, Math.PI * 2);
	ctx.stroke();
	ctx.strokeStyle = withAlpha({ color: primaryGlow, alpha: 0.18 });
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * 0.78, 0, Math.PI * 2);
	ctx.stroke();
	ctx.restore();

	ctx.save();
	ctx.lineWidth = 2.5;
	ctx.lineCap = "round";
	ctx.strokeStyle = withAlpha({ color: ringColor, alpha: 0.18 });
	ctx.beginPath();
	ctx.arc(centerX, centerY, radius * 0.91, 0, Math.PI * 2);
	ctx.stroke();
	ctx.shadowColor = "rgba(190,255,120,0.55)";
	ctx.shadowBlur = 14;
	ctx.strokeStyle = ringColor;
	ctx.beginPath();
	ctx.arc(
		centerX,
		centerY,
		radius * 0.91,
		-Math.PI / 2,
		-Math.PI / 2 + Math.PI * 2 * visibleRemaining,
	);
	ctx.stroke();
	ctx.restore();

	const labelNumber = Number(label);
	const countdownNumber = Number.isFinite(labelNumber)
		? Math.max(0, Math.ceil(labelNumber * visibleRemaining))
		: null;
	const displayText =
		countdownNumber !== null ? String(countdownNumber).padStart(2, "0") : label;
	drawSevenSegmentText({
		ctx,
		text: displayText,
		x: centerX,
		y: centerY,
		height: radius * 0.54,
		color: foreground || "#C9FF8F",
		alpha: 0.84,
	});
}

function drawSevenSegmentText({
	ctx,
	text,
	x,
	y,
	height,
	color,
	alpha,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	text: string;
	x: number;
	y: number;
	height: number;
	color: string;
	alpha: number;
}) {
	const chars = text.slice(0, 3).split("");
	const digitWidth = height * 0.56;
	const gap = height * 0.18;
	const totalWidth =
		chars.length * digitWidth + Math.max(0, chars.length - 1) * gap;
	let cursorX = x - totalWidth / 2;
	for (const char of chars) {
		drawSevenSegmentDigit({
			ctx,
			char,
			x: cursorX,
			y: y - height / 2,
			width: digitWidth,
			height,
			color,
			alpha,
		});
		cursorX += digitWidth + gap;
	}
}

function drawSevenSegmentDigit({
	ctx,
	char,
	x,
	y,
	width,
	height,
	color,
	alpha,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	char: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
	alpha: number;
}) {
	const segmentMap: Record<string, number[]> = {
		"0": [0, 1, 2, 3, 4, 5],
		"1": [1, 2],
		"2": [0, 1, 6, 4, 3],
		"3": [0, 1, 6, 2, 3],
		"4": [5, 6, 1, 2],
		"5": [0, 5, 6, 2, 3],
		"6": [0, 5, 6, 2, 3, 4],
		"7": [0, 1, 2],
		"8": [0, 1, 2, 3, 4, 5, 6],
		"9": [0, 1, 2, 3, 5, 6],
	};
	const activeSegments = segmentMap[char] ?? [];
	const thickness = Math.max(3, height * 0.08);
	const horizontalWidth = width - thickness * 1.35;
	const verticalHeight = height * 0.42;
	const left = x + thickness * 0.3;
	const right = x + width - thickness * 0.7;
	const top = y + thickness * 0.35;
	const mid = y + height / 2;
	const bottom = y + height - thickness * 0.75;
	const segments = [
		{ x: x + thickness * 0.68, y: top, w: horizontalWidth, h: thickness },
		{ x: right, y: y + thickness * 0.9, w: thickness, h: verticalHeight },
		{ x: right, y: mid + thickness * 0.35, w: thickness, h: verticalHeight },
		{ x: x + thickness * 0.68, y: bottom, w: horizontalWidth, h: thickness },
		{ x: left, y: mid + thickness * 0.35, w: thickness, h: verticalHeight },
		{ x: left, y: y + thickness * 0.9, w: thickness, h: verticalHeight },
		{
			x: x + thickness * 0.68,
			y: mid - thickness * 0.1,
			w: horizontalWidth,
			h: thickness,
		},
	];

	ctx.save();
	ctx.shadowColor = withAlpha({ color, alpha: 0.5 });
	ctx.shadowBlur = 10;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		const isActive = activeSegments.includes(index);
		ctx.globalAlpha *= isActive ? alpha : 0.08;
		ctx.fillStyle = color;
		ctx.fill(
			roundRect({
				x: segment.x,
				y: segment.y,
				width: segment.w,
				height: segment.h,
				radius: thickness / 2,
			}),
		);
		ctx.globalAlpha /= isActive ? alpha : 0.08;
	}
	ctx.restore();
}

export const uiElementGraphicDefinition: GraphicDefinition = {
	id: UI_ELEMENT_GRAPHIC_ID,
	name: "UI Element",
	keywords: [
		"ui",
		"button",
		"motion",
		"graphic",
		"overlay",
		"hud",
		"battery",
		"wasted",
	],
	params: UI_ELEMENT_PARAMS,
	sourceSize: ({ params }) => getUiElementSourceSize({ params }),
	render({ ctx, params, width, height, localTime = 0, duration }) {
		const template = String(params.template ?? "neon-button");
		const label = String(params.label ?? "Continue");
		const secondary = String(params.secondary ?? "Details");
		const itemCount = Math.round(
			clampValue({ value: Number(params.itemCount ?? 4), min: 1, max: 8 }),
		);
		const items = buildItems({
			value: String(params.items ?? ""),
			count: itemCount,
		});
		const labelFontFamily = String(params.labelFontFamily ?? "Inter");
		const secondaryFontFamily = String(
			params.secondaryFontFamily ?? labelFontFamily,
		);
		const itemsFontFamily = String(params.itemsFontFamily ?? labelFontFamily);
		const textDirectionValue = String(params.textDirection ?? "auto");
		const textDirection =
			textDirectionValue === "rtl" || textDirectionValue === "ltr"
				? textDirectionValue
				: "auto";
		const textRevealMode =
			UI_ELEMENT_TEXT_REVEAL_OPTIONS.find(
				(option) => option.value === params.textRevealMode,
			)?.value ?? "determined-by-preset";
		const textTransitionIn =
			UI_ELEMENT_TEXT_TRANSITION_OPTIONS.find(
				(option) => option.value === params.textTransitionIn,
			)?.value ?? "blur-zoom";
		const animationIn = String(params.animationIn ?? "auto");
		const animationOut = String(params.animationOut ?? "auto");
		const animationInEnd = Number(params.animationInEnd ?? 18);
		const animationOutStart = Number(params.animationOutStart ?? 82);
		const animationStrength =
			clampValue({
				value: Number(params.animationStrength ?? 100),
				min: 0,
				max: 200,
			}) / 100;
		const eventAt = Number(params.eventAt ?? 55);
		const itemStartPointValue = String(params.itemStartPoints ?? "");
		const itemEndPointValue = String(params.itemEndPoints ?? "");
		const listRevealMode = String(params.listRevealMode ?? "sequential");
		const listBaseOpacity = clampValue({
			value: Number(params.listBaseOpacity ?? 0),
			min: 0,
			max: 1,
		});
		const listRiseDistance = clampValue({
			value: Number(params.listRiseDistance ?? 36),
			min: 0,
			max: 160,
		});
		const listItemInDuration = clampValue({
			value: Number(params.listItemInDuration ?? 8),
			min: 0,
			max: 50,
		});
		const listItemOutDuration = clampValue({
			value: Number(params.listItemOutDuration ?? 8),
			min: 0,
			max: 50,
		});
		const listBarWidth = clampValue({
			value: Number(params.listBarWidth ?? 54),
			min: 20,
			max: 90,
		});
		const listBarHeight = clampValue({
			value: Number(params.listBarHeight ?? 8),
			min: 3,
			max: 18,
		});
		const listBarGap = clampValue({
			value: Number(params.listBarGap ?? 2.5),
			min: 0,
			max: 12,
		});
		const listBarRadius = clampValue({
			value: Number(params.listBarRadius ?? 14),
			min: 0,
			max: 60,
		});
		const listBarFitToText = params.listBarFitToText === true;
		const listBackgroundBlur = clampValue({
			value: Number(params.listBackgroundBlur ?? 0),
			min: 0,
			max: 30,
		});
		const listTextAlignValue = String(params.listTextAlign ?? "auto");
		const listTextAlign =
			listTextAlignValue === "left" ||
			listTextAlignValue === "center" ||
			listTextAlignValue === "right"
				? listTextAlignValue
				: "auto";
		const listTextSize = clampValue({
			value: Number(params.listTextSize ?? 28),
			min: 12,
			max: 72,
		});
		const accent = String(params.accent ?? "#00e5ff");
		const background = String(params.background ?? "#111827");
		const foreground = String(params.foreground ?? "#ffffff");
		const progress = clampValue({
			value: Number(params.progress ?? 64),
			min: 0,
			max: 100,
		});
		const batteryModeValue = String(params.batteryMode ?? "drain");
		const batteryMode = batteryModeValue === "charge" ? "charge" : "drain";
		const screenModeValue = String(params.screenMode ?? "auto");
		const screenMode: OverlayScreenMode =
			screenModeValue === "wide" ||
			screenModeValue === "vertical" ||
			screenModeValue === "square"
				? screenModeValue
				: "auto";
		const checked = Math.round(
			clampValue({ value: Number(params.checked ?? 2), min: 0, max: 10 }),
		);
		const count = Math.round(
			clampValue({ value: Number(params.count ?? 3), min: 0, max: 9999 }),
		);
		const intensity =
			clampValue({ value: Number(params.intensity ?? 60), min: 0, max: 100 }) /
			100;
		const timing = resolveUiMotionTiming({
			localTime,
			duration,
			animationInEnd,
			animationOutStart,
			eventAt,
			textRevealMode,
			textTransitionIn,
			textDirection,
		});
		const visibleItemCount = Math.min(items.length, 6);
		const itemStartPoints = parsePercentPoints({
			value: itemStartPointValue,
			count: visibleItemCount,
			fallback: (index) =>
				visibleItemCount <= 1
					? 0
					: (animationInEnd / Math.max(1, visibleItemCount - 1)) * index,
		});
		const itemEndPoints = parsePercentPoints({
			value: itemEndPointValue,
			count: visibleItemCount,
			fallback: () => animationOutStart,
		});

		ctx.clearRect(0, 0, width, height);
		ctx.globalAlpha = 1;

		withUiMotion({
			ctx,
			width,
			height,
			animationIn,
			animationOut,
			timing,
			animationStrength,
			accent,
			render: () => {
				switch (template) {
					case "click-button":
					case "subscribe-button":
						drawButton({
							ctx,
							width,
							height,
							label,
							labelFontFamily,
							accent,
							background,
							foreground,
							localTime,
							textMotion: timing.textMotion,
							click: true,
						});
						break;
					case "rotating-bars":
						drawBars({ ctx, width, height, accent, foreground, localTime });
						break;
					case "flipping-bars":
					case "waveform":
						drawBars({
							ctx,
							width,
							height,
							accent,
							foreground,
							localTime: localTime * (1 + intensity),
							flip: true,
						});
						break;
					case "anime-chat-bubble": {
						const x = width * 0.18;
						const y = height * 0.22;
						const bubbleWidth = width * 0.64;
						const bubbleHeight = height * 0.35;
						ctx.fillStyle = background;
						ctx.fill(
							roundRect({
								x,
								y,
								width: bubbleWidth,
								height: bubbleHeight,
								radius: 34,
							}),
						);
						ctx.beginPath();
						ctx.moveTo(x + bubbleWidth * 0.18, y + bubbleHeight);
						ctx.lineTo(x + bubbleWidth * 0.25, y + bubbleHeight + height * 0.1);
						ctx.lineTo(x + bubbleWidth * 0.36, y + bubbleHeight);
						ctx.closePath();
						ctx.fill();
						ctx.strokeStyle = accent;
						ctx.lineWidth = 5;
						ctx.stroke(
							roundRect({
								x,
								y,
								width: bubbleWidth,
								height: bubbleHeight,
								radius: 34,
							}),
						);
						drawCenteredText({
							ctx,
							text: label,
							x: width / 2,
							y: y + bubbleHeight * 0.45,
							maxWidth: bubbleWidth * 0.78,
							size: 42,
							color: foreground,
							fontFamily: labelFontFamily,
							motion: timing.textMotion,
						});
						drawCenteredText({
							ctx,
							text: secondary,
							x: width / 2,
							y: y + bubbleHeight * 0.68,
							maxWidth: bubbleWidth * 0.78,
							size: 24,
							color: accent,
							fontFamily: secondaryFontFamily,
							weight: 700,
							motion: timing.textMotion,
						});
						break;
					}
					case "progress-bar":
						drawProgress({
							ctx,
							width,
							height,
							label,
							labelFontFamily,
							secondaryFontFamily,
							progress,
							accent,
							background,
							foreground,
							textMotion: timing.textMotion,
							animationIn,
							animationOut,
							inProgress: timing.inProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "bullet-list":
						drawList({
							ctx,
							width,
							height,
							items,
							itemsFontFamily,
							accent,
							background,
							foreground,
							checked,
							checkbox: false,
							textMotion: timing.textMotion,
							animationIn,
							inProgress: timing.inProgress,
							outProgress: timing.outProgress,
							eventProgress: timing.eventProgress,
							timelineProgress: timing.timelineProgress,
							itemStartPoints,
							itemEndPoints,
							listRevealMode,
							listBaseOpacity,
							listRiseDistance,
							listItemInDuration,
							listItemOutDuration,
							listBarWidth,
							listBarHeight,
							listBarGap,
							listBarRadius,
							listBarFitToText,
							listBackgroundBlur,
							listTextAlign,
							listTextSize,
						});
						break;
					case "checkbox-list":
						drawList({
							ctx,
							width,
							height,
							items,
							itemsFontFamily,
							accent,
							background,
							foreground,
							checked,
							checkbox: true,
							textMotion: timing.textMotion,
							animationIn,
							inProgress: timing.inProgress,
							outProgress: timing.outProgress,
							eventProgress: timing.eventProgress,
							timelineProgress: timing.timelineProgress,
							itemStartPoints,
							itemEndPoints,
							listRevealMode,
							listBaseOpacity,
							listRiseDistance,
							listItemInDuration,
							listItemOutDuration,
							listBarWidth,
							listBarHeight,
							listBarGap,
							listBarRadius,
							listBarFitToText,
							listBackgroundBlur,
							listTextAlign,
							listTextSize,
						});
						break;
					case "leaderboard":
						drawList({
							ctx,
							width,
							height,
							items,
							itemsFontFamily,
							accent,
							background,
							foreground,
							checked,
							checkbox: false,
							textMotion: timing.textMotion,
							animationIn,
							inProgress: timing.inProgress,
							outProgress: timing.outProgress,
							eventProgress: timing.eventProgress,
							timelineProgress: timing.timelineProgress,
							itemStartPoints,
							itemEndPoints,
							listRevealMode,
							listBaseOpacity,
							listRiseDistance,
							listItemInDuration,
							listItemOutDuration,
							listBarWidth,
							listBarHeight,
							listBarGap,
							listBarRadius,
							listBarFitToText,
							listBackgroundBlur,
							listTextAlign,
							listTextSize,
						});
						break;
					case "lower-third": {
						const y = height * 0.58;
						ctx.fillStyle = background;
						ctx.fillRect(width * 0.12, y, width * 0.58, height * 0.16);
						ctx.fillStyle = accent;
						ctx.fillRect(width * 0.12, y, width * 0.025, height * 0.16);
						drawTextLine({
							ctx,
							text: label,
							x: width * 0.17,
							y: y + height * 0.055,
							maxWidth: width * 0.48,
							size: 38,
							color: foreground,
							fontFamily: labelFontFamily,
							weight: 800,
							align: "left",
							motion: timing.textMotion,
						});
						drawTextLine({
							ctx,
							text: secondary,
							x: width * 0.17,
							y: y + height * 0.115,
							maxWidth: width * 0.48,
							size: 22,
							color: accent,
							fontFamily: secondaryFontFamily,
							weight: 600,
							align: "left",
							motion: timing.textMotion,
						});
						break;
					}
					case "counter": {
						const displayCount = Math.round(count * timing.contentProgress);
						drawCenteredText({
							ctx,
							text: String(displayCount),
							x: width / 2,
							y: height * 0.42,
							maxWidth: width * 0.5,
							size: 104,
							color: accent,
							fontFamily: labelFontFamily,
							motion: timing.textMotion,
						});
						drawCenteredText({
							ctx,
							text: label,
							x: width / 2,
							y: height * 0.59,
							maxWidth: width * 0.5,
							size: 38,
							color: foreground,
							fontFamily: secondaryFontFamily,
							motion: timing.textMotion,
						});
						break;
					}
					case "chart-bars":
						drawChart({
							ctx,
							width,
							height,
							accent,
							foreground,
							line: false,
							motionProgress: timing.contentProgress,
						});
						break;
					case "line-chart":
						drawChart({
							ctx,
							width,
							height,
							accent,
							foreground,
							line: true,
							motionProgress: timing.contentProgress,
						});
						break;
					case "hud-countdown":
						drawHudCountdown({
							ctx,
							width,
							height,
							label,
							accent,
							background,
							foreground,
							localTime,
							duration,
							progress,
							motionProgress: timing.contentProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "battery-drain":
						drawBatteryDrain({
							ctx,
							width,
							height,
							label,
							secondary,
							labelFontFamily,
							secondaryFontFamily,
							accent,
							background,
							foreground,
							progress,
							batteryMode,
							intensity,
							localTime,
							duration,
							textMotion: timing.textMotion,
							motionProgress: timing.contentProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "hud-radar-sweep":
					case "hud-target-lock":
					case "hud-signal-scanner":
					case "hud-data-core":
					case "hud-alert-beacon":
					case "hud-direction-shift":
						drawNeoHudGraphic({
							ctx,
							width,
							height,
							template,
							label,
							secondary,
							labelFontFamily,
							secondaryFontFamily,
							accent,
							background,
							foreground,
							progress,
							intensity,
							localTime,
							duration,
							textMotion: timing.textMotion,
							motionProgress: timing.contentProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "direction-cross-arrows":
						drawDirectionCrossArrows({
							ctx,
							width,
							height,
							accent,
							background,
							foreground,
							progress,
							intensity,
							localTime,
							motionProgress: timing.contentProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "wasted-overlay":
						drawWastedOverlay({
							ctx,
							width,
							height,
							label,
							secondary,
							labelFontFamily,
							secondaryFontFamily,
							accent,
							background,
							foreground,
							screenMode,
							intensity,
							localTime,
							timing,
							animationIn,
							animationOut,
						});
						break;
					case "badge":
					case "callout":
					case "panel":
					case "notification":
					case "price-tag":
					case "app-window":
					case "timeline-stepper":
					case "split-title":
					case "social-card":
					case "stats-grid":
					case "loading-ring":
					case "countdown":
					case "toggle-switch":
					case "rating-stars":
					case "tooltip":
					case "carousel-dots":
						drawSimpleCard({
							ctx,
							width,
							height,
							label,
							secondary,
							labelFontFamily,
							secondaryFontFamily,
							accent,
							background,
							foreground,
							template,
							progress,
							count,
							localTime,
							textMotion: timing.textMotion,
							motionProgress: timing.contentProgress,
							outProgress: timing.outProgress,
						});
						break;
					case "neon-button":
					default:
						drawButton({
							ctx,
							width,
							height,
							label,
							labelFontFamily,
							accent,
							background,
							foreground,
							localTime,
							textMotion: timing.textMotion,
						});
				}
			},
		});
	},
};
