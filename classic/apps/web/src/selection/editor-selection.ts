import type { SelectedKeyframeRef } from "@/animation/types";
import type { ElementRef } from "@/timeline/types";

export interface SelectedTextWordRef extends ElementRef {
	wordId: string;
}

export interface SelectedMaskPointSelection {
	trackId: string;
	elementId: string;
	maskId: string;
	pointIds: string[];
}

export interface EditorSelectionSnapshot {
	selectedElements: ElementRef[];
	selectedTextWords: SelectedTextWordRef[];
	selectedKeyframes: SelectedKeyframeRef[];
	keyframeSelectionAnchor: SelectedKeyframeRef | null;
	selectedMaskPoints: SelectedMaskPointSelection | null;
}

export interface EditorSelectionPatch {
	selectedElements?: ElementRef[];
	selectedTextWords?: SelectedTextWordRef[];
	selectedKeyframes?: SelectedKeyframeRef[];
	keyframeSelectionAnchor?: SelectedKeyframeRef | null;
	selectedMaskPoints?: SelectedMaskPointSelection | null;
}

export type EditorSelectionKind =
	| "mask-points"
	| "keyframes"
	| "text-words"
	| "elements";
