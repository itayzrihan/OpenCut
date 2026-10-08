import type { Bookmark, SceneTracks } from "@/timeline/types";

export type SmartTakeMode = "standard" | "experimental";
export interface TakeRunMetrics {
	elapsedMs: number;
	stages: { stage: string; durationMs: number }[];
}
export interface TakeReview {
	plan: SmartTakePlan;
	story: {
		groupIndex: number;
		label: string;
		selected: number;
		dialogue: string;
	}[];
	groups: {
		groupIndex: number;
		reasons: string[];
		alternatives: {
			alternativeIndex: number;
			label: string;
			dialogue: string;
			parts: TakePart[];
		}[];
	}[];
	discarded: (TakePart & { reason: string; dialogue: string })[];
}
export type ReviewTakes = (input: {
	plan: SmartTakePlan;
	selections?: { groupIndex: number; alternativeIndex: number }[];
}) => TakeReview;

export interface TakePart {
	firstWord: number;
	lastWord: number;
}
export interface TakeAlternative {
	label: string;
	reason: string;
	parts: TakePart[];
}
export interface TakeGroup {
	label: string;
	/** Semantic confidence, not a measured probability of performance quality. */
	confidence: number;
	selected: number;
	alternatives: TakeAlternative[];
}
export interface SmartTakePlan {
	groups: TakeGroup[];
	discarded: (TakePart & { reason: string })[];
}
export interface SmartTakeWord {
	id: number;
	sourceIndex: number;
	clipId: string;
	text: string;
	start: number;
	end: number;
}
export interface PreparedTakes {
	revision: number;
	words: SmartTakeWord[];
}
export interface TakeAssembly {
	selectionOnly?: boolean;
	version: 1 | 2;
	mode?: SmartTakeMode;
	runMetrics?: TakeRunMetrics;
	quality?: {
		shortParts: number;
		repeatedPhrases: number;
		unverifiedBoundaries: number;
		audioDiagnostics?: {
			clipId: string;
			framesAnalyzed: number;
			coveredStart: number | null;
			coveredEnd: number | null;
			duration: number;
			quietRanges: number;
			safetyHoldReason: string | null;
		}[];
	};
	sourceWords: SmartTakeWord[];
	recommendations: number[];
	id: string;
	elementIds: string[];
	sourceTracks: SceneTracks;
	sourceBookmarks: Bookmark[];
	plan: SmartTakePlan;
	appliedDigest: string;
}
export interface TakeAudioEvidence {
	clipId: string;
	frames: {
		start: number;
		end: number;
		rms: number;
		peak: number;
		zeroCrossingRate: number;
	}[];
}
export type TakeChange =
	| {
			type: "assemble";
			elementIds: string[];
			plan: SmartTakePlan;
			mode?: SmartTakeMode;
			runMetrics?: TakeRunMetrics;
			audioEvidence?: TakeAudioEvidence[];
	  }
	| { type: "select"; groupIndex: number; alternativeIndex: number };
