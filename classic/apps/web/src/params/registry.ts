import type { ParamDefinition, ParamValue, ParamValues } from "@/params";
import { MIN_TRANSFORM_SCALE } from "@/animation/transform";
import type { BlendMode } from "@/rendering";
import type { ElementType, TimelineElement } from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "@/timeline/audio-constants";
import { CORNER_RADIUS_MAX, CORNER_RADIUS_MIN } from "@/text/background";

const FONT_WEIGHT_OPTIONS = [
	{ value: "normal", label: "Normal" },
	{ value: "100", label: "100 Thin" },
	{ value: "200", label: "200 Extra Light" },
	{ value: "300", label: "300 Light" },
	{ value: "400", label: "400 Regular" },
	{ value: "500", label: "500 Medium" },
	{ value: "600", label: "600 Semi Bold" },
	{ value: "700", label: "700 Bold" },
	{ value: "800", label: "800 Extra Bold" },
	{ value: "900", label: "900 Black" },
	{ value: "bold", label: "Bold" },
];

export type ElementParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		read?: ({ element }: { element: TimelineElement }) => ParamValue | null;
		write?: ({
			element,
			value,
		}: {
			element: TimelineElement;
			value: ParamValue;
		}) => TimelineElement;
	};

export function buildDefaultParamValues(
	params: readonly ParamDefinition[],
): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		values[param.key] = param.default;
	}
	return values;
}

export class DefinitionRegistry<TKey extends string, TDefinition> {
	private definitions = new Map<TKey, TDefinition>();
	private entityName: string;

	constructor(entityName: string) {
		this.entityName = entityName;
	}

	register({ key, definition }: { key: TKey; definition: TDefinition }): void {
		this.definitions.set(key, definition);
	}

	has(key: TKey): boolean {
		return this.definitions.has(key);
	}

	get(key: TKey): TDefinition {
		const def = this.definitions.get(key);
		if (!def) {
			throw new Error(`Unknown ${this.entityName}: ${key}`);
		}
		return def;
	}

	getAll(): TDefinition[] {
		return Array.from(this.definitions.values());
	}
}

const BLEND_MODE_OPTIONS: Array<{ value: BlendMode; label: string }> = [
	{ value: "normal", label: "Normal" },
	{ value: "darken", label: "Darken" },
	{ value: "multiply", label: "Multiply" },
	{ value: "color-burn", label: "Color Burn" },
	{ value: "lighten", label: "Lighten" },
	{ value: "screen", label: "Screen" },
	{ value: "plus-lighter", label: "Plus Lighter" },
	{ value: "color-dodge", label: "Color Dodge" },
	{ value: "overlay", label: "Overlay" },
	{ value: "soft-light", label: "Soft Light" },
	{ value: "hard-light", label: "Hard Light" },
	{ value: "difference", label: "Difference" },
	{ value: "exclusion", label: "Exclusion" },
	{ value: "hue", label: "Hue" },
	{ value: "saturation", label: "Saturation" },
	{ value: "color", label: "Color" },
	{ value: "luminosity", label: "Luminosity" },
];

const visualElementParams: ElementParamDefinition[] = [
	{
		key: "transform.positionX",
		label: "Position X",
		type: "number",
		default: DEFAULTS.element.transform.position.x,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.positionY",
		label: "Position Y",
		type: "number",
		default: DEFAULTS.element.transform.position.y,
		min: -100_000,
		step: 1,
	},
	{
		key: "transform.scaleX",
		label: "Scale X",
		type: "number",
		default: DEFAULTS.element.transform.scaleX,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.scaleY",
		label: "Scale Y",
		type: "number",
		default: DEFAULTS.element.transform.scaleY,
		min: MIN_TRANSFORM_SCALE,
		step: 0.01,
	},
	{
		key: "transform.rotate",
		label: "Rotate",
		type: "number",
		default: DEFAULTS.element.transform.rotate,
		min: -360,
		max: 360,
		step: 1,
	},
	{
		key: "transform.perspectiveX",
		label: "Perspective X",
		type: "number",
		default: DEFAULTS.element.transform.perspectiveX,
		min: -75,
		max: 75,
		step: 1,
	},
	{
		key: "transform.perspectiveY",
		label: "Perspective Y",
		type: "number",
		default: DEFAULTS.element.transform.perspectiveY,
		min: -75,
		max: 75,
		step: 1,
	},
	{
		key: "opacity",
		label: "Opacity",
		type: "number",
		default: DEFAULTS.element.opacity,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "blendMode",
		label: "Blend Mode",
		type: "select",
		default: DEFAULTS.element.blendMode,
		keyframable: false,
		options: BLEND_MODE_OPTIONS,
	},
];

const audioElementParams: ElementParamDefinition[] = [
	{
		key: "volume",
		label: "Volume",
		type: "number",
		default: DEFAULTS.element.volume,
		min: VOLUME_DB_MIN,
		max: VOLUME_DB_MAX,
		step: 0.01,
	},
	{
		key: "muted",
		label: "Muted",
		type: "boolean",
		default: false,
		keyframable: false,
	},
	{
		key: "fadeInDuration",
		label: "Fade In Duration",
		type: "number",
		default: DEFAULTS.element.audioFadeDuration,
		min: 0,
		step: 0.01,
		keyframable: false,
	},
	{
		key: "fadeOutDuration",
		label: "Fade Out Duration",
		type: "number",
		default: DEFAULTS.element.audioFadeDuration,
		min: 0,
		step: 0.01,
		keyframable: false,
	},
];

const textElementParams: ElementParamDefinition[] = [
	{
		key: "content",
		label: "Content",
		type: "text",
		default: "Default text",
		keyframable: false,
	},
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		default: "Arial",
		keyframable: false,
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		default: 15,
		min: 1,
		step: 1,
	},
	{
		key: "color",
		label: "Color",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "textFillMode",
		label: "Text Fill",
		type: "select",
		default: "solid",
		keyframable: false,
		options: [
			{ value: "solid", label: "Solid color" },
			{ value: "gradient", label: "Gradient" },
		],
	},
	{
		key: "gradientStartColor",
		label: "Gradient Start",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "gradientEndColor",
		label: "Gradient End",
		type: "color",
		default: "#7c3aed",
	},
	{
		key: "gradientAngle",
		label: "Gradient Angle",
		type: "number",
		default: 0,
		min: -360,
		max: 360,
		step: 1,
	},
	{
		key: "textAlign",
		label: "Text Align",
		type: "select",
		default: "center",
		keyframable: false,
		options: [
			{ value: "left", label: "Left" },
			{ value: "center", label: "Center" },
			{ value: "right", label: "Right" },
		],
	},
	{
		key: "fontWeight",
		label: "Font Weight",
		type: "select",
		default: "normal",
		keyframable: false,
		options: FONT_WEIGHT_OPTIONS,
	},
	{
		key: "fontStyle",
		label: "Font Style",
		type: "select",
		default: "normal",
		keyframable: false,
		options: [
			{ value: "normal", label: "Normal" },
			{ value: "italic", label: "Italic" },
		],
	},
	{
		key: "textDecoration",
		label: "Text Decoration",
		type: "select",
		default: "none",
		keyframable: false,
		options: [
			{ value: "none", label: "None" },
			{ value: "underline", label: "Underline" },
			{ value: "line-through", label: "Line Through" },
		],
	},
	{
		key: "letterSpacing",
		label: "Letter Spacing",
		type: "number",
		default: DEFAULTS.text.letterSpacing,
		min: -100,
		step: 0.1,
	},
	{
		key: "lineHeight",
		label: "Line Height",
		type: "number",
		default: DEFAULTS.text.lineHeight,
		min: 0.1,
		step: 0.1,
	},
	{
		key: "stroke.enabled",
		label: "Stroke",
		type: "boolean",
		default: DEFAULTS.text.stroke.enabled,
		keyframable: false,
	},
	{
		key: "stroke.color",
		label: "Stroke Color",
		type: "color",
		default: DEFAULTS.text.stroke.color,
		dependencies: [{ param: "stroke.enabled", equals: true }],
	},
	{
		key: "stroke.width",
		label: "Stroke Width",
		type: "number",
		default: DEFAULTS.text.stroke.width,
		min: 0,
		max: 100,
		step: 0.5,
		shortLabel: "W",
		dependencies: [{ param: "stroke.enabled", equals: true }],
	},
	{
		key: "shadow.enabled",
		label: "Shadow",
		type: "boolean",
		default: DEFAULTS.text.shadow.enabled,
		keyframable: false,
	},
	{
		key: "shadow.color",
		label: "Shadow Color",
		type: "color",
		default: DEFAULTS.text.shadow.color,
		dependencies: [{ param: "shadow.enabled", equals: true }],
	},
	{
		key: "shadow.blur",
		label: "Shadow Blur",
		type: "number",
		default: DEFAULTS.text.shadow.blur,
		min: 0,
		max: 200,
		step: 0.5,
		shortLabel: "B",
		dependencies: [{ param: "shadow.enabled", equals: true }],
	},
	{
		key: "shadow.offsetX",
		label: "Shadow X",
		type: "number",
		default: DEFAULTS.text.shadow.offsetX,
		min: -500,
		max: 500,
		step: 0.5,
		shortLabel: "X",
		dependencies: [{ param: "shadow.enabled", equals: true }],
	},
	{
		key: "shadow.offsetY",
		label: "Shadow Y",
		type: "number",
		default: DEFAULTS.text.shadow.offsetY,
		min: -500,
		max: 500,
		step: 0.5,
		shortLabel: "Y",
		dependencies: [{ param: "shadow.enabled", equals: true }],
	},
	{
		key: "background.enabled",
		label: "Background Enabled",
		type: "boolean",
		default: DEFAULTS.text.background.enabled,
		keyframable: false,
	},
	{
		key: "background.color",
		label: "Background Color",
		type: "color",
		default: DEFAULTS.text.background.color,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.cornerRadius",
		label: "Background Radius",
		type: "number",
		default: DEFAULTS.text.background.cornerRadius,
		min: CORNER_RADIUS_MIN,
		max: CORNER_RADIUS_MAX,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingX",
		label: "Background Padding X",
		type: "number",
		default: DEFAULTS.text.background.paddingX,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.paddingY",
		label: "Background Padding Y",
		type: "number",
		default: DEFAULTS.text.background.paddingY,
		min: 0,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetX",
		label: "Background Offset X",
		type: "number",
		default: DEFAULTS.text.background.offsetX,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
	{
		key: "background.offsetY",
		label: "Background Offset Y",
		type: "number",
		default: DEFAULTS.text.background.offsetY,
		min: -100_000,
		step: 1,
		dependencies: [{ param: "background.enabled", equals: true }],
	},
];

export const elementParamRegistry = new DefinitionRegistry<
	ElementType,
	readonly ElementParamDefinition[]
>("element params");

elementParamRegistry.register({
	key: "video",
	definition: [...visualElementParams, ...audioElementParams],
});
elementParamRegistry.register({
	key: "image",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "text",
	definition: [...textElementParams, ...visualElementParams],
});
elementParamRegistry.register({
	key: "sticker",
	definition: visualElementParams,
});
elementParamRegistry.register({
	key: "graphic",
	definition: visualElementParams,
});
elementParamRegistry.register({ key: "audio", definition: audioElementParams });
elementParamRegistry.register({ key: "effect", definition: [] });

export function getElementParams({
	element,
}: {
	element: TimelineElement;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(element.type)
		? elementParamRegistry.get(element.type)
		: [];
}

export function getBuiltInElementParams({
	type,
}: {
	type: ElementType;
}): readonly ElementParamDefinition[] {
	return elementParamRegistry.has(type) ? elementParamRegistry.get(type) : [];
}

export function getElementParam({
	element,
	key,
}: {
	element: TimelineElement;
	key: string;
}): ElementParamDefinition | null {
	return (
		getElementParams({ element }).find((param) => param.key === key) ?? null
	);
}

export function readElementParamValue({
	element,
	param,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
}): ParamValue | null {
	if (param.read) {
		return param.read({ element });
	}
	if ("params" in element) {
		return element.params[param.key] ?? param.default;
	}
	return null;
}

export function writeElementParamValue({
	element,
	param,
	value,
}: {
	element: TimelineElement;
	param: ElementParamDefinition;
	value: ParamValue;
}): TimelineElement {
	if (param.write) {
		return param.write({ element, value });
	}
	if ("params" in element) {
		return {
			...element,
			params: {
				...element.params,
				[param.key]: value,
			},
		};
	}
	return element;
}

export function buildElementParamValues({
	element,
}: {
	element: TimelineElement;
}): ParamValues {
	const values: ParamValues = {};
	for (const param of getElementParams({ element })) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}
