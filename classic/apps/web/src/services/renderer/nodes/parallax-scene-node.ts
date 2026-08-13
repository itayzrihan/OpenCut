import type { OverlayMovementFrame } from "@/effects/overlay-movement-presets";
import type { ParamValues } from "@/params";
import type { ElementAnimations } from "@/animation/types";
import { BaseNode } from "./base-node";
import type { ParallaxMotionLoopFrame } from "@/parallax-story-teller/motion-loop";

export interface ParallaxSceneNodeParams {
	timeOffset: number;
	duration: number;
	sourceDuration: number;
	effectParams: ParamValues;
	storyParams: ParamValues;
	effectAnimations?: ElementAnimations;
	cameraWidth?: number;
	cameraHeight?: number;
	cameraDuration: number;
	cameraTimeOffset: number;
	cameraUsesSourceTime: boolean;
	worldWidthFrames: number;
	worldHeightFrames: number;
}

export interface ResolvedParallaxSceneNodeState {
	movement: OverlayMovementFrame;
	motionLoop: ParallaxMotionLoopFrame | null;
}

export class ParallaxSceneNode extends BaseNode<
	ParallaxSceneNodeParams,
	ResolvedParallaxSceneNodeState
> {}
