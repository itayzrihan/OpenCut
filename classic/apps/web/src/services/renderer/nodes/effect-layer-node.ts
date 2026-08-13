import type { EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import type { ElementAnimations } from "@/animation/types";
import type { OverlayMovementFrame } from "@/effects/overlay-movement-presets";
import type { EffectLayerVisualOverlay } from "../effect-layer-visual-overlay";
import { BaseNode } from "./base-node";

export type EffectLayerNodeParams = {
	effectType: string;
	effectParams: ParamValues;
	effectAnimations?: ElementAnimations;
	timeOffset: number;
	duration: number;
	cameraWidth?: number;
	cameraHeight?: number;
};

export type ResolvedEffectLayerNodeState = {
	passes: EffectPass[];
	visualOverlay: EffectLayerVisualOverlay | null;
	movement: OverlayMovementFrame | null;
	overlay: EffectLayerOverlay | null;
};

export type EffectLayerOverlay = {
	label: string;
	intent?: string;
};

export class EffectLayerNode extends BaseNode<
	EffectLayerNodeParams,
	ResolvedEffectLayerNodeState
> {}
