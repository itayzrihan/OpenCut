/** Serializable source contract owned by crates/editor-api. */
export interface HyperframesSource {
	entryFile: string;
	files: Record<string, string>;
	resourceAssetIds: Record<string, string>;
}

export interface HyperframesComposition {
	source: HyperframesSource;
	compositionId: string;
	width: number;
	height: number;
	fps: number;
	durationSeconds: number;
	runtimeManifest?: HyperframesRuntimeManifest;
}

/** Read-only canonical projection into one existing Classic compound clip. */
export interface HyperframesTimelineClip {
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
export interface HyperframesRenderContext {
	compositions: Readonly<Record<string, HyperframesComposition>>;
	/** Changes when a bound resource is replaced, even at the same source time. */
	getResourceRevision: () => number;
	renderTo: (input: {
		composition: HyperframesComposition;
		timeSeconds: number;
		target: OffscreenCanvas;
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
