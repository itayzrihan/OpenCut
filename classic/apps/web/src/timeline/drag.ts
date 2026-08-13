import type {
	CreateTimelineElement,
	ElementType,
	MaskableElement,
	TrackType,
	VisualElement,
} from "./types";
import type { ParamValues } from "@/params";
import type { MediaTime } from "@/wasm";

interface BaseDragData {
	id: string;
	name: string;
}

export interface MediaDragData extends BaseDragData {
	type: "media";
	mediaType: "image" | "video" | "audio";
	targetElementTypes?: MaskableElement["type"][];
}

export interface TextDragData extends BaseDragData {
	type: "text";
	content: string;
	params?: Partial<ParamValues>;
}

export interface StickerDragData extends BaseDragData {
	type: "sticker";
	stickerId: string;
}

export interface GraphicDragData extends BaseDragData {
	type: "graphic";
	definitionId: string;
	params: Partial<ParamValues>;
	duration?: MediaTime;
}

export interface EffectDragData extends BaseDragData {
	type: "effect";
	effectType: string;
	params?: Partial<ParamValues>;
	targetElementTypes: VisualElement["type"][];
	placement?: "clip" | "layer" | "layer-above-target";
	duration?: MediaTime;
}

export interface TransitionDragData extends BaseDragData {
	type: "transition";
	transitionId: string;
	targetElementTypes: VisualElement["type"][];
}

export interface LoopDragData extends BaseDragData {
	type: "loop";
	loopId: string;
	targetElementTypes: VisualElement["type"][];
}

export interface ElementBundleDragData extends BaseDragData {
	type: "element-bundle";
	anchorElementType: ElementType;
	duration: MediaTime;
	items: Array<{
		trackType: TrackType;
		/**
		 * The element start time is stored relative to the bundle origin and is
		 * translated to the drop position by the timeline controller.
		 */
		element: CreateTimelineElement;
	}>;
}

export type TimelineDragData =
	| MediaDragData
	| TextDragData
	| StickerDragData
	| GraphicDragData
	| EffectDragData
	| TransitionDragData
	| LoopDragData
	| ElementBundleDragData;
