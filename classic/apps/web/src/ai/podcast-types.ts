import type {
	TakeAlternative,
	SmartTakeWord,
} from "@/timeline/smart-takes/types";
export type PodcastMode = "teaser" | "highlights" | "chronological";
export interface PodcastOptions {
	mode: PodcastMode;
	minSeconds: number;
	maxSeconds: number;
	maxOutputs: number;
}
export interface PodcastVideo {
	title: string;
	openingHook: string;
	endingHook: string;
	confidence: number;
	alternatives: TakeAlternative[];
}
export interface PodcastSource {
	revision: number;
	sourceFingerprint?: string;
	words: SmartTakeWord[];
	windows: { index: number; words: SmartTakeWord[] }[];
	/** Canonical policy owns selection/review; the browser only transports jobs. */
	editorial?: (input: {
		options: PodcastOptions;
		responses: Record<string, unknown>;
	}) => PodcastEditorialStep;
}
export interface PodcastEditorialStep {
	policyVersion: string;
	complete: boolean;
	requests: {
		key: string;
		stage: string;
		instructions: string;
		prompt: unknown;
	}[];
	videos: PodcastVideo[];
	report: Record<string, unknown>;
}
export interface PodcastExtract {
	version: 1;
	sourceSceneId: string;
	options: PodcastOptions;
	title: string;
	openingHook: string;
	endingHook: string;
}
