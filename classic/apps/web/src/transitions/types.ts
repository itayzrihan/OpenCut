import type {
	ElementAnimations,
	ScalarAnimationChannel,
} from "@/animation/types";
import type { TimelineElement } from "@/timeline";

export type TransitionProperty =
	| "opacity"
	| "transform.positionX"
	| "transform.positionY"
	| "transform.scaleX"
	| "transform.scaleY"
	| "transform.rotate"
	| "transition.shatter"
	| "background.paddingX"
	| "background.paddingY"
	| "background.offsetX"
	| "background.offsetY"
	| "background.cornerRadius";

export type TransitionState = Partial<Record<TransitionProperty, number>>;
export type TransitionRecipe = Partial<
	Record<TransitionProperty, Array<{ at: number; value: number }>>
>;

export interface TransitionPreset {
	id: string;
	label: string;
	keywords: string[];
	state: TransitionState;
	recipe?: TransitionRecipe;
}

export type TransitionSide = "in" | "out";

export interface BuildTransitionAnimationsParams {
	element: TimelineElement;
	inTransitionId: string;
	outTransitionId: string;
	inDuration?: import("@/wasm").MediaTime;
	outDuration?: import("@/wasm").MediaTime;
	inStartTime?: import("@/wasm").MediaTime;
	outStartTime?: import("@/wasm").MediaTime;
	inPercent?: number;
	outPercent?: number;
}

export interface TransitionAnimationPatch {
	animations?: ElementAnimations;
	transitions?: TimelineElement["transitions"];
}

export type TransitionChannelBuilder = (
	keys: Array<{ time: number; value: number }>,
) => ScalarAnimationChannel;
