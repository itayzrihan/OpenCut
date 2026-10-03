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
