import type {
	ElementRef,
	ElementType,
	TimelineElement,
	TrackType,
} from "@/timeline";
import type { MediaTime } from "@/wasm";

export interface AiTimelineRange {
	startTime: MediaTime;
	endTime: MediaTime;
}

export interface AiLayerSummary {
	id: string;
	name: string;
	type: TrackType;
	index: number;
	section: "overlay" | "main" | "audio";
	elementCount: number;
	hidden?: boolean;
	muted?: boolean;
}

export interface AiElementSummary extends ElementRef {
	name: string;
	type: ElementType;
	startTime: MediaTime;
	endTime: number;
	duration: MediaTime;
	params: Record<string, string | number | boolean>;
	mediaId?: string;
	sourceUrl?: string;
	text?: string;
	effects?: Array<{
		id: string;
		type: string;
		enabled: boolean;
		params: Record<string, string | number | boolean>;
	}>;
	masks?: Array<{
		id: string;
		type: string;
		inverted?: boolean;
	}>;
	backgroundRemoval?: {
		enabled: boolean;
		mode: "remove" | "blur" | "grayscale";
		quality: "fast" | "balanced" | "precise";
		maskThreshold: number;
		edgeContrast: number;
		edgeFeather: number;
		temporalSmoothing: number;
		blurStrength: number;
	};
	keyframes?: Array<{
		propertyPath: string;
		keyframeId: string;
		time: number;
		value: string | number | boolean;
		interpolation?: string;
		componentKey?: string;
	}>;
	hidden?: boolean;
	muted?: boolean;
}

export interface AiTimelineIndex {
	layers: AiLayerSummary[];
	elements: AiElementSummary[];
	elementsById: Map<string, AiElementSummary>;
	layersById: Map<string, AiLayerSummary>;
}

export interface AiEditPlan {
	title: string;
	summary: string;
	operations: AiEditOperation[];
	notes?: string[];
}

export type AiCustomEditSpec =
	| string
	| number
	| boolean
	| null
	| AiCustomEditSpec[]
	| { [key: string]: AiCustomEditSpec };

export type AiEditOperation =
	| {
			type: "apply_timeline_source_v2";
			baseRevision: string;
			document: string;
			scope?: AiTimelineRange;
			reason?: string;
	  }
	| {
			type: "update_element";
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
			reason?: string;
	  }
	| {
			type: "insert_text_element";
			trackId?: string;
			name?: string;
			content: string;
			startTime: MediaTime;
			duration: MediaTime;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "trim_element";
			trackId: string;
			elementId: string;
			trimStart?: MediaTime;
			trimEnd?: MediaTime;
			startTime?: MediaTime;
			duration?: MediaTime;
			reason?: string;
	  }
	| {
			type: "move_element";
			sourceTrackId: string;
			targetTrackId: string;
			elementId: string;
			startTime: MediaTime;
			reason?: string;
	  }
	| {
			type: "split_element";
			trackId: string;
			elementId: string;
			splitTime: MediaTime;
			retainSide?: "both" | "left" | "right";
			reason?: string;
	  }
	| {
			type: "delete_element";
			trackId: string;
			elementId: string;
			reason?: string;
	  }
	| {
			type: "add_clip_effect";
			trackId: string;
			elementId: string;
			effectType: string;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "attach_custom_edit";
			trackId: string;
			elementId: string;
			label: string;
			kind?: string;
			intent?: string;
			startTime?: MediaTime;
			duration?: MediaTime;
			spec: AiCustomEditSpec;
			reason?: string;
	  }
	| {
			type: "update_clip_effect_params";
			trackId: string;
			elementId: string;
			effectId: string;
			params: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "remove_clip_effect";
			trackId: string;
			elementId: string;
			effectId: string;
			reason?: string;
	  }
	| {
			type: "set_clip_effect_enabled";
			trackId: string;
			elementId: string;
			effectId: string;
			enabled: boolean;
			reason?: string;
	  }
	| {
			type: "reorder_clip_effect";
			trackId: string;
			elementId: string;
			fromIndex: number;
			toIndex: number;
			reason?: string;
	  }
	| {
			type: "set_background_removal";
			trackId: string;
			elementId: string;
			enabled: boolean;
			mode?: "remove" | "blur" | "grayscale";
			quality?: "fast" | "balanced" | "precise";
			maskThreshold?: number;
			edgeContrast?: number;
			edgeFeather?: number;
			temporalSmoothing?: number;
			blurStrength?: number;
			duplicate?: boolean;
			reason?: string;
	  }
	| {
			type: "upsert_keyframe";
			trackId: string;
			elementId: string;
			propertyPath: string;
			time: MediaTime;
			value: string | number | boolean;
			interpolation?: "linear" | "hold";
			keyframeId?: string;
			reason?: string;
	  }
	| {
			type: "remove_keyframe";
			trackId: string;
			elementId: string;
			propertyPath: string;
			keyframeId: string;
			reason?: string;
	  }
	| {
			type: "add_track";
			trackType: TrackType;
			index?: number;
			reason?: string;
	  }
	| {
			type: "remove_track";
			trackId: string;
			reason?: string;
	  }
	| {
			type: "reorder_track";
			trackId: string;
			toIndex: number;
			reason?: string;
	  }
	| {
			type: "set_track_state";
			trackId: string;
			muted?: boolean;
			hidden?: boolean;
			reason?: string;
	  }
	| {
			type: "insert_media_element";
			mediaId: string;
			startTime: MediaTime;
			trackId?: string;
			duration?: MediaTime;
			name?: string;
			reason?: string;
	  }
	| {
			type: "insert_library_audio_element";
			libraryAssetId: string;
			name: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			reason?: string;
	  }
	| {
			type: "insert_graphic_element";
			definitionId: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			name?: string;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "insert_html_element";
			html: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			name?: string;
			sourceWidth?: number;
			sourceHeight?: number;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "insert_sticker_element";
			stickerId: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			name?: string;
			intrinsicWidth?: number;
			intrinsicHeight?: number;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "insert_effect_element";
			effectType: string;
			startTime: MediaTime;
			duration: MediaTime;
			trackId?: string;
			name?: string;
			params?: Record<string, string | number | boolean>;
			reason?: string;
	  }
	| {
			type: "duplicate_element";
			trackId: string;
			elementId: string;
			reason?: string;
	  }
	| {
			type: "apply_transition";
			trackId: string;
			elementId: string;
			presetId: string;
			side: "in" | "out";
			percent?: number;
			reason?: string;
	  }
	| {
			type: "set_element_state";
			trackId: string;
			elementId: string;
			hidden?: boolean;
			muted?: boolean;
			reason?: string;
	  }
	| {
			type: "retime_element";
			trackId: string;
			elementId: string;
			rate: number;
			maintainPitch?: boolean;
			reason?: string;
	  }
	| {
			type: "create_scene";
			name: string;
			reason?: string;
	  }
	| {
			type: "rename_scene";
			sceneId: string;
			name: string;
			reason?: string;
	  }
	| {
			type: "delete_scene";
			sceneId: string;
			reason?: string;
	  }
	| {
			type: "set_project_settings";
			fps?: { numerator: number; denominator: number };
			canvasSize?: { width: number; height: number };
			background?:
				| { type: "color"; color: string }
				| { type: "blur"; blurIntensity: number };
			reason?: string;
	  }
	| {
			type: "add_bookmark";
			time: MediaTime;
			note?: string;
			color?: string;
			duration?: MediaTime;
			reason?: string;
	  }
	| {
			type: "update_bookmark";
			time: MediaTime;
			note?: string;
			color?: string;
			duration?: MediaTime;
			reason?: string;
	  }
	| {
			type: "remove_bookmark";
			time: MediaTime;
			reason?: string;
	  }
	| {
			type: "move_bookmark";
			fromTime: MediaTime;
			toTime: MediaTime;
			reason?: string;
	  }
	| {
			type: "start_export_task";
			format: "mp4" | "webm";
			quality: "low" | "medium" | "high" | "very_high";
			includeAudio?: boolean;
			reason?: string;
	  }
	| {
			type: "start_transcription_task";
			language?: string;
			reason?: string;
	  };

export interface AiToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface AiToolDefinition {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
	/** Keep only frequently used tools in the initial model context. */
	deferLoading?: boolean;
	/** Compact discovery metadata; never forwarded as part of the function schema. */
	category?: string;
	keywords?: string[];
	/** Read-only calls may be executed concurrently when the provider returns a batch. */
	readOnly?: boolean;
	/** Only explicitly idempotent, closed-world reads may run concurrently. */
	idempotent?: boolean;
	/** Open-world calls may consume untrusted external data and never auto-chain to writes. */
	openWorld?: boolean;
	/** Host-enforced risk class; metadata is stripped before sending the schema. */
	risk?: "read" | "control" | "edit" | "destructive" | "external";
	/** Explicit user grants required before the host exposes this capability. */
	requiredPermissions?: Array<
		"layers" | "media" | "preview" | "app_control" | "network"
	>;
	/** Deterministic host policy returned by the Rust authorization broker. */
	executionPolicy?: "immediate" | "review" | "confirm" | "denied";
}

export interface AiAgentMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface AiCitation {
	url: string;
	title?: string;
}

export interface AiAgentResult {
	status: "completed" | "cancelled" | "max_iterations" | "error";
	text: string;
	editPlan: AiEditPlan | null;
	iterations: number;
	error?: string;
	citations?: AiCitation[];
}
