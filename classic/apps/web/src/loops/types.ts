import type {
	AnimationPropertyPath,
	ElementAnimations,
} from "@/animation/types";

export type LoopProperty = Extract<
	AnimationPropertyPath,
	| "opacity"
	| "transform.positionX"
	| "transform.positionY"
	| "transform.scaleX"
	| "transform.scaleY"
	| "transform.rotate"
>;

export type LoopKey = {
	at: number;
	value: number;
};

export type LoopRecipe = Partial<Record<LoopProperty, LoopKey[]>>;

export interface LoopPreset {
	id: string;
	label: string;
	keywords: string[];
	cycleSeconds: number;
	recipe: LoopRecipe;
	accumulate?: LoopProperty[];
}

export interface AppliedLoop {
	presetId: string;
	cycleSeconds: number;
	properties: LoopProperty[];
}

export interface LoopAnimationPatch {
	animations?: ElementAnimations;
	loop?: AppliedLoop;
}
