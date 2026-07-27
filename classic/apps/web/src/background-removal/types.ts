export type BackgroundRemovalMode = "remove" | "blur" | "grayscale";

export type BackgroundRemovalQuality = "fast" | "balanced" | "precise";

export interface BackgroundRemovalSettings {
	enabled: boolean;
	mode: BackgroundRemovalMode;
	quality: BackgroundRemovalQuality;
	maskThreshold: number;
	edgeContrast: number;
	edgeFeather: number;
	temporalSmoothing: number;
	blurStrength: number;
}

export interface ResolvedBackgroundRemovalSettings extends BackgroundRemovalSettings {
	inputSize: number;
	previewFps: number;
	cacheEntries: number;
	blurSigma: number;
}

export type BackgroundRemovalDuplicatePlacement =
	| { kind: "existingTrack"; trackId: string }
	| { kind: "newTrack"; insertIndex: number };
