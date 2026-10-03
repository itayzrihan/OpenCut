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
