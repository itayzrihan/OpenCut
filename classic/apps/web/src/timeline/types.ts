import type { ElementAnimations } from "@/animation/types";
import type { Effect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { CaptionLayoutSettings } from "@/subtitles/caption-layout";
import type { TranscriptionWord } from "@/transcription/types";
import type { MediaTime } from "@/wasm";
import type {
	TextAlign,
	TextDecoration,
	TextFontStyle,
	TextFontWeight,
} from "@/text/primitives";
import type { BlendMode } from "@/rendering";
import type { BackgroundRemovalSettings } from "@/background-removal/types";

export type ElementRef = {
	trackId: string;
	elementId: string;
};

export interface Bookmark {
	time: MediaTime;
	note?: string;
	color?: string;
	duration?: MediaTime;
}

export interface TScene {
	id: string;
	name: string;
	isMain: boolean;
	tracks: SceneTracks;
	bookmarks: Bookmark[];
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";

interface BaseTrack {
	id: string;
	name: string;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	elements: (VideoElement | ImageElement)[];
	muted: boolean;
	hidden: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	elements: TextElement[];
	hidden: boolean;
	captionSource?: {
		sourceId?: string;
		words: TranscriptionWord[];
		settings: CaptionLayoutSettings;
		layerIndex?: number;
		layerCount?: number;
	};
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	elements: AudioElement[];
	muted: boolean;
}

export interface GraphicTrack extends BaseTrack {
	type: "graphic";
	elements: (StickerElement | GraphicElement)[];
	hidden: boolean;
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
	elements: EffectElement[];
	hidden: boolean;
}

export type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| GraphicTrack
	| EffectTrack;

export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;

export interface SceneTracks {
	overlay: OverlayTrack[];
	main: VideoTrack;
	audio: AudioTrack[];
	order?: string[];
}

export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

interface BaseAudioElement extends BaseTimelineElement {
	type: "audio";
	buffer?: AudioBuffer;
	retime?: RetimeConfig;
}

export interface UploadAudioElement extends BaseAudioElement {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioElement extends BaseAudioElement {
	sourceType: "library";
	sourceUrl?: string;
	libraryAssetId?: string;
	librarySourceType?: "remote" | "shared";
}

export type AudioElement = UploadAudioElement | LibraryAudioElement;

interface BaseTimelineElement {
	id: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	animations?: ElementAnimations;
	transitions?: ElementTransitions;
	params: ParamValues;
}

export interface AppliedElementTransition {
	id: string;
	presetId: string;
	placement: "in" | "out" | "cut-left" | "cut-right";
	duration: MediaTime;
	startTime?: MediaTime;
	createdAt: string;
}

export interface ElementTransitions {
	in?: AppliedElementTransition;
	out?: AppliedElementTransition;
}

export interface VideoElement extends BaseTimelineElement {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	hidden?: boolean;
	retime?: RetimeConfig;
	effects?: Effect[];
	masks?: Mask[];
	backgroundRemoval?: BackgroundRemovalSettings;
}

export interface ImageElement extends BaseTimelineElement {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface TextElement extends BaseTimelineElement {
	type: "text";
	hidden?: boolean;
	effects?: Effect[];
	wordRuns?: TextWordRun[];
	textRowOverrides?: TextRowOverride[];
	captionWordAnimationId?: string;
	captionRevealMode?: TextCaptionRevealMode;
	captionTransitionIn?: TextWordTransitionIn;
	captionAccentColor?: string;
	captionWordDirection?: TextWordDirection;
	captionGlowerEnabled?: boolean;
	captionGlowerDirection?: TextWordDirection;
	captionLightningStormEnabled?: boolean;
	captionGlitchyEnabled?: boolean;
	clipMediaId?: string;
}

export type TextCaptionRevealMode =
	| "determined-by-preset"
	| "row"
	| "spoken-word"
	| "spoken-word-keep"
	| "emphasize-spoken"
	| "emphasize-spoken-keep"
	| "letter-by-letter"
	| "growing-row";

export type TextWordTransitionIn =
	| "none"
	| "fade"
	| "blur"
	| "zoom"
	| "blur-zoom"
	| "rise"
	| "slide"
	| "typewriter"
	| "glow-dissolve";

export type TextWordDirection = "auto" | "ltr" | "rtl";

export interface TextWordStyle {
	fontSize?: number;
	fontFamily?: string;
	color?: string;
	textAlign?: TextAlign;
	fontWeight?: TextFontWeight;
	fontStyle?: TextFontStyle;
	textDecoration?: TextDecoration;
	letterSpacing?: number;
	lineHeight?: number;
	opacity?: number;
	scale?: number;
	scaleX?: number;
	scaleY?: number;
	rotate?: number;
	blur?: number;
	shadowBlur?: number;
	shadowColor?: string;
	shadowOffsetX?: number;
	shadowOffsetY?: number;
	strokeWidth?: number;
	strokeColor?: string;
	characterReveal?: boolean;
	offsetX?: number;
	offsetY?: number;
	blendMode?: BlendMode;
	backgroundEnabled?: boolean;
	backgroundColor?: string;
	backgroundCornerRadius?: number;
	backgroundPaddingX?: number;
	backgroundPaddingY?: number;
	backgroundOffsetX?: number;
	backgroundOffsetY?: number;
}

export interface TextWordOverrideSettings {
	style?: TextWordStyle;
	revealMode?: TextCaptionRevealMode;
	transitionIn?: TextWordTransitionIn;
	wordAnimationId?: string;
	accentColor?: string;
	wordDirection?: TextWordDirection;
	glowerEnabled?: boolean;
	glowerDirection?: TextWordDirection;
	lightningStormEnabled?: boolean;
	glitchyEnabled?: boolean;
}

export interface TextRowOverride extends TextWordOverrideSettings {
	id: string;
	lineIndex: number;
}

export interface TextWordRun extends TextWordOverrideSettings {
	id: string;
	text: string;
	lineIndex: number;
	startTime?: MediaTime;
	endTime?: MediaTime;
}

export interface StickerElement extends BaseTimelineElement {
	type: "sticker";
	stickerId: string;
	/** Natural dimensions of the sticker asset, stored at insert time. Used by renderer and preview bounds to avoid split-brain geometry. */
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	hidden?: boolean;
	effects?: Effect[];
}

export interface GraphicElement extends BaseTimelineElement {
	type: "graphic";
	definitionId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface EffectElement extends BaseTimelineElement {
	type: "effect";
	effectType: string;
}

export type ElementUpdatePatch = { params?: Partial<ParamValues> };

export type TimelineElement =
	| AudioElement
	| VideoElement
	| ImageElement
	| TextElement
	| StickerElement
	| GraphicElement
	| EffectElement;

export type ElementType = TimelineElement["type"];

function elementTypes<T extends ElementType[]>(...types: T): T {
	return types;
}

export const MASKABLE_ELEMENT_TYPES = elementTypes("video", "image", "graphic");

export type MaskableElement = Extract<
	TimelineElement,
	{ type: (typeof MASKABLE_ELEMENT_TYPES)[number] }
>;

export const RETIMABLE_ELEMENT_TYPES = elementTypes("video", "audio");

export type RetimableElement = Extract<
	TimelineElement,
	{ type: (typeof RETIMABLE_ELEMENT_TYPES)[number] }
>;

export const VISUAL_ELEMENT_TYPES = elementTypes(
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
);

export type VisualElement = Extract<
	TimelineElement,
	{ type: (typeof VISUAL_ELEMENT_TYPES)[number] }
>;

export type CreateUploadAudioElement = Omit<UploadAudioElement, "id">;
export type CreateLibraryAudioElement = Omit<LibraryAudioElement, "id">;
export type CreateAudioElement =
	| CreateUploadAudioElement
	| CreateLibraryAudioElement;
export type CreateVideoElement = Omit<VideoElement, "id">;
export type CreateImageElement = Omit<ImageElement, "id">;
export type CreateTextElement = Omit<TextElement, "id">;
export type CreateStickerElement = Omit<StickerElement, "id">;
export type CreateGraphicElement = Omit<GraphicElement, "id">;
export type CreateEffectElement = Omit<EffectElement, "id">;
export type CreateTimelineElement =
	| CreateAudioElement
	| CreateVideoElement
	| CreateImageElement
	| CreateTextElement
	| CreateStickerElement
	| CreateGraphicElement
	| CreateEffectElement;

export interface ElementDragState {
	isDragging: boolean;
	elementId: string | null;
	dragElementIds: string[];
	dragTimeOffsets: Record<string, MediaTime>;
	trackId: string | null;
	startMouseX: number;
	startMouseY: number;
	startElementTime: MediaTime;
	clickOffsetTime: MediaTime;
	currentTime: MediaTime;
	currentMouseY: number;
}

export type ElementDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorElementId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, MediaTime>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startElementTime: MediaTime;
			readonly clickOffsetTime: MediaTime;
			readonly currentTime: MediaTime;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: DropTarget | null;
	  };

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: MediaTime;
	targetElement: { elementId: string; trackId: string } | null;
}

export interface ComputeDropTargetParams {
	elementType: ElementType;
	mouseX: number;
	mouseY: number;
	tracks: SceneTracks;
	playheadTime: MediaTime;
	isExternalDrop: boolean;
	elementDuration: MediaTime;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: MediaTime;
	excludeElementId?: string;
	targetElementTypes?: string[];
}

export interface ClipboardItem {
	trackId: string;
	trackType: TrackType;
	element: CreateTimelineElement;
}
