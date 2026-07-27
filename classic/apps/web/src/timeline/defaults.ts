import type { TTimelineViewState } from "@/project/types";
import type { BlendMode, Transform } from "@/rendering";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import type { TextElement } from "./types";

const defaultTransform: Transform = {
	scaleX: 1,
	scaleY: 1,
	position: { x: 0, y: 0 },
	rotate: 0,
	perspectiveX: 0,
	perspectiveY: 0,
};

const defaultOpacity = 1;
const defaultBlendMode: BlendMode = "normal";
const defaultVolume = 0;
const defaultAudioFadeDuration = 0;

const defaultTextLetterSpacing = 0;
const defaultTextLineHeight = 1.2;
const defaultNewElementDuration = mediaTime({ ticks: 5 * TICKS_PER_SECOND });

const defaultTextBackground = {
	enabled: false,
	color: "#000000",
	cornerRadius: 0,
	paddingX: 30,
	paddingY: 42,
	offsetX: 0,
	offsetY: 0,
};

const defaultTextStroke = {
	enabled: false,
	color: "#000000",
	width: 3,
};

const defaultTextShadow = {
	enabled: false,
	color: "#000000",
	blur: 10,
	offsetX: 0,
	offsetY: 4,
};

const defaultTextElement: Omit<TextElement, "id"> = {
	type: "text",
	name: "Text",
	duration: defaultNewElementDuration,
	startTime: ZERO_MEDIA_TIME,
	trimStart: ZERO_MEDIA_TIME,
	trimEnd: ZERO_MEDIA_TIME,
	params: {
		content: "Default text",
		fontSize: 15,
		fontFamily: "Arial",
		color: "#ffffff",
		textFillMode: "solid",
		gradientStartColor: "#ffffff",
		gradientEndColor: "#7c3aed",
		gradientAngle: 0,
		textAlign: "center",
		fontWeight: "normal",
		fontStyle: "normal",
		textDecoration: "none",
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		"stroke.enabled": defaultTextStroke.enabled,
		"stroke.color": defaultTextStroke.color,
		"stroke.width": defaultTextStroke.width,
		"shadow.enabled": defaultTextShadow.enabled,
		"shadow.color": defaultTextShadow.color,
		"shadow.blur": defaultTextShadow.blur,
		"shadow.offsetX": defaultTextShadow.offsetX,
		"shadow.offsetY": defaultTextShadow.offsetY,
		"background.enabled": defaultTextBackground.enabled,
		"background.color": defaultTextBackground.color,
		"background.cornerRadius": defaultTextBackground.cornerRadius,
		"background.paddingX": defaultTextBackground.paddingX,
		"background.paddingY": defaultTextBackground.paddingY,
		"background.offsetX": defaultTextBackground.offsetX,
		"background.offsetY": defaultTextBackground.offsetY,
		"transform.positionX": defaultTransform.position.x,
		"transform.positionY": defaultTransform.position.y,
		"transform.scaleX": defaultTransform.scaleX,
		"transform.scaleY": defaultTransform.scaleY,
		"transform.rotate": defaultTransform.rotate,
		"transform.perspectiveX": defaultTransform.perspectiveX,
		"transform.perspectiveY": defaultTransform.perspectiveY,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
	},
};

const defaultTimelineViewState: TTimelineViewState = {
	zoomLevel: 1,
	scrollLeft: 0,
	playheadTime: ZERO_MEDIA_TIME,
};

export const DEFAULTS = {
	element: {
		transform: defaultTransform,
		opacity: defaultOpacity,
		blendMode: defaultBlendMode,
		volume: defaultVolume,
		audioFadeDuration: defaultAudioFadeDuration,
	},
	text: {
		letterSpacing: defaultTextLetterSpacing,
		lineHeight: defaultTextLineHeight,
		background: defaultTextBackground,
		stroke: defaultTextStroke,
		shadow: defaultTextShadow,
		element: defaultTextElement,
	},
	timeline: {
		viewState: defaultTimelineViewState,
	},
};
