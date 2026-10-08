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
	words: SmartTakeWord[];
	windows: { index: number; words: SmartTakeWord[] }[];
}
export interface PodcastExtract {
	version: 1;
	sourceSceneId: string;
	options: PodcastOptions;
	title: string;
	openingHook: string;
	endingHook: string;
}
