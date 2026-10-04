/** Serializable source contract owned by crates/editor-api. */
export interface HyperframesSource {
	entryFile: string;
	files: Record<string, string>;
	resourceAssetIds: Record<string, string>;
	variables?: Record<string, unknown>;
}

export interface HyperframesVariable {
	id: string;
	file: string;
	declaration: {
		type: "string" | "number" | "boolean" | "color" | "enum" | "font" | "image";
		label?: string;
		description?: string;
		default?: unknown;
		placeholder?: string;
		maxLength?: number;
		min?: number;
		max?: number;
		step?: number;
		options?: Array<{ value: string; label?: string }>;
	};
}

export interface HyperframesComposition {
	importId?: string;
	source: HyperframesSource;
	compositionId: string;
	width: number;
	height: number;
	fps: number;
	durationSeconds: number;
	runtimeManifest?: HyperframesRuntimeManifest;
}

/** Display metadata projected by the canonical Classic library capability. */
export interface HyperframesLibraryItem {
	assetId: string;
	name: string;
	entryFile: string;
	width: number;
	height: number;
	fps: number;
	durationSeconds: number;
	sourceFileCount: number;
	sourceFingerprint: string;
	importId?: string;
	resourceAssetIds: string[];
	occurrences: Array<{
		sceneId: string;
		sceneName: string;
		trackId: string;
		elementId: string;
		name: string;
		startTime: number;
	}>;
}

/** Read-only canonical projection into one existing Classic compound clip. */
export interface HyperframesTimelineClip {
	controls: Array<{ key: string; editable: boolean; opacity: number }>;
	trackId: string;
	elementId: string;
	compositionId: string;
	name: string;
	rows: Array<{
		key: string;
		parentKey: string | null;
		label: string;
		kind: HyperframesRuntimeLayer["kind"];
		depth: number;
		startTime: number;
		duration: number;
		sourceStartSeconds: number;
		sourceEndSeconds: number;
	}>;
}

export interface HyperframesRuntimeManifest {
	sourceFingerprint: string;
	runtimeVersion: string;
	durationSeconds: number;
	layers: HyperframesRuntimeLayer[];
	diagnostics: string[];
}

export interface HyperframesRuntimeLayer {
	key: string;
	parentKey: string | null;
	file: string | null;
	elementId: string | null;
	label: string;
	kind: "composition" | "element" | "image" | "video" | "audio";
	startSeconds: number;
	durationSeconds: number;
	trackIndex: number;
	resourcePath: string | null;
	playbackStartSeconds: number;
	playbackRate: number;
	media: {
		sourceDurationSeconds: number | null;
		muted: boolean;
		looping: boolean;
		attributes: Record<string, string>;
	} | null;
}

/** Rendering dependencies projected from a canonical Classic project. */
export interface HyperframesLiveHandle {
	url: string;
	/** Release the browser client's reserved cache slot; never changes a project. */
	release?: () => void;
}

/** Canonical per-clip overrides, bound to the preserved source package. */
export interface HyperframesLayerEdits {
	sourceFingerprint: string;
	manifestFingerprint: string;
	opacity: Record<string, number>;
}

export interface HyperframesLayerRenderEdit {
	key: string;
	elementId: string;
	opacity: number;
}

export interface HyperframesRenderContext {
	compositions: Readonly<Record<string, HyperframesComposition>>;
	/** Changes when a bound resource is replaced, even at the same source time. */
	getResourceRevision: () => number;
	/** Silent, isolated DOM surface. The full capture renderer remains the fallback. */
	openLivePreview?: (input: {
		composition: HyperframesComposition;
		layerEdits?: HyperframesLayerEdits;
	}) => Promise<HyperframesLiveHandle>;
	renderTo: (input: {
		composition: HyperframesComposition;
		layerEdits?: HyperframesLayerEdits;
		timeSeconds: number;
		target: OffscreenCanvas;
		/** Derived preview quality; omitted for full-resolution export. */
		previewScale?: number;
	}) => Promise<void>;
}

export interface HyperframesPackagePlan {
	entryFile: string | null;
	entryCandidates: string[];
	files: Array<{
		path: string;
		size: number;
		kind: "source" | "resource";
		mimeType: string;
		mediaType: "image" | "video" | "audio" | "file";
	}>;
	ignoredPaths: string[];
	sourceBytes: number;
	resourceBytes: number;
}

export interface HyperframesInspection {
	fingerprint: string;
	compositionId: string;
	width: number;
	height: number;
	fps: number;
	durationSeconds: number | null;
	requiresRuntime: boolean;
	elements: Array<{
		key: string;
		parentKey: string | null;
		file: string;
		elementId: string | null;
		tag: string;
		label: string | null;
		trackIndex: number | null;
		attributes: Record<string, string>;
	}>;
	dependencies: Array<{
		file: string;
		reference: string;
		packagePath: string | null;
		status: "source" | "asset" | "missing" | "external";
	}>;
	diagnostics: Array<{ code: string; file: string; message: string }>;
}
