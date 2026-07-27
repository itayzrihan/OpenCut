import type { EffectPass } from "@/effects/types";
import type { ParamValues } from "@/params";
import type { OverlayMovementFrame } from "@/effects/overlay-movement-presets";
import type { EffectLayerVisualOverlay } from "../effect-layer-visual-overlay";
import { BaseNode } from "./base-node";

export type EffectLayerNodeParams = {
	effectType: string;
	effectParams: ParamValues;
	timeOffset: number;
	duration: number;
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
