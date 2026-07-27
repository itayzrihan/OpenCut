import type { FrameRate } from "opencut-wasm";
import type { ProjectFont } from "@/fonts/types";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface AiEditTargetRefs {
	sceneId?: string;
	trackId?: string;
	elementId?: string;
	effectId?: string;
	transitionId?: string;
	keyframeId?: string;
	propertyPath?: string;
}

export type AiEditAnchor =
	| { kind: "range"; startTime: MediaTime; duration: MediaTime }
	| { kind: "point"; time: MediaTime }
	| { kind: "project" };

export interface AiEditLayerRecord {
	id: string;
	operationType: string;
	label: string;
	reason?: string;
	anchor: AiEditAnchor;
	refs: AiEditTargetRefs[];
	operationIds: string[];
	operationCount: number;
	tombstone: boolean;
}

export interface AiEditPlanRecord {
	schemaVersion: number;
	id: string;
	title: string;
	summary: string;
	appliedAt?: string;
	sceneId?: string;
	layers: AiEditLayerRecord[];
	operationCount: number;
	truncatedOperationCount: number;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	customFonts?: ProjectFont[];
	aiEditHistory?: AiEditPlanRecord[];
	version: number;
	timelineViewState?: TTimelineViewState;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
