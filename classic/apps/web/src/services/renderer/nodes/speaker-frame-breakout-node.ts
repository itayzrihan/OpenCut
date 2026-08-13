import type { BackgroundMaskFrame } from "@/services/background-removal";
import type { ParamValues } from "@/params";
import type { Effect, EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import type { RetimeConfig, VisualElement } from "@/timeline/types";
import type { MediaTime } from "@/wasm";
import type { SpeakerFrameBreakoutSettings } from "@/simple-advanced-layers/speaker-frame-breakout";
import { BaseNode } from "./base-node";

export type SpeakerFrameBreakoutSource = {
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

export type SpeakerFrameBreakoutNodeParams = {
	layerId: string;
	timeOffset: MediaTime;
	duration: MediaTime;
	settings: SpeakerFrameBreakoutSettings;
	currentSourceSignature: string;
	isAppliedAndCurrent: boolean;
	isPreview: boolean;
	sources: SpeakerFrameBreakoutSource[];
};

export type ResolvedSpeakerFrameBreakoutNodeState = {
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	sourceElementId: string;
	sourceMediaId: string;
	sourceTime: number;
	backgroundParams: ParamValues;
	mask: BackgroundMaskFrame | null;
	transform: Transform;
	cropTop: number;
	cornerRadius: number;
	opacity: number;
	sourceOpacity: number;
	blendMode: BlendMode;
	effectPassGroups: EffectPass[][];
	cameraDepth: number;
	cameraLocked: boolean;
	localTime: number;
};

export class SpeakerFrameBreakoutNode extends BaseNode<
	SpeakerFrameBreakoutNodeParams,
	ResolvedSpeakerFrameBreakoutNodeState
> {}
