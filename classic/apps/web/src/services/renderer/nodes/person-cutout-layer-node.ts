import type { BackgroundMaskFrame } from "@/services/background-removal";
import type { BackgroundRemovalMode } from "@/background-removal";
import type { Effect, EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";
import type { PersonCutoutLayerSettings } from "@/simple-advanced-layers/person-cutout-layer";
import { BaseNode } from "./base-node";

export type PersonCutoutLayerSource = {
	trackId: string;
	trackIndex: number;
	elementId: string;
	mediaId: string;
	url?: string;
	file?: File;
	duration: MediaTime;
	timeOffset: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode: BlendMode;
	effects: Effect[];
	cameraDepth: number;
	cameraLocked: boolean;
};

export type PersonCutoutLayerNodeParams = {
	layerId: string;
	timeOffset: MediaTime;
	duration: MediaTime;
	settings: PersonCutoutLayerSettings;
	currentSourceSignature: string;
	isAppliedAndCurrent: boolean;
	isPreview: boolean;
	sources: PersonCutoutLayerSource[];
};

export type ResolvedPersonCutoutLayerNodeState = {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	sourceElementId: string;
	sourceMediaId: string;
	sourceTime: number;
	mask: BackgroundMaskFrame | null;
	backgroundMode: BackgroundRemovalMode;
	backgroundEffectPasses: EffectPass[][];
	transform: Transform;
	opacity: number;
	sourceOpacity: number;
	blendMode: BlendMode;
	effectPassGroups: EffectPass[][];
	cameraDepth: number;
	cameraLocked: boolean;
	localTime: number;
};

export class PersonCutoutLayerNode extends BaseNode<
	PersonCutoutLayerNodeParams,
	ResolvedPersonCutoutLayerNodeState
> {}
