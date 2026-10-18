/** Serialized projection of the canonical Classic transcription job. */
import type { SceneTracks } from "@/timeline";
import type { CaptionLayoutSettings } from "@/subtitles/caption-layout";
import type { TranscriptionLanguage, TranscriptionWord } from "./types";
export type TranscriptionEngine = "local" | "external";
export interface TranscriptionJob {
	engine?: TranscriptionEngine;
	externalConfiguration?: string | null;
	id: string;
	sceneId: string;
	language: TranscriptionLanguage;
	settings: CaptionLayoutSettings;
	defaults: Record<string, unknown>;
	sourceTracks: SceneTracks;
	sourceMedia: Record<string, unknown>[];
	totalDuration: number;
	status: "running" | "paused" | "complete" | "superseded";
	chunks: Record<string, TranscriptionWord[]>;
}
export type TranscriptionChange =
	| { type: "setEngine"; engine: TranscriptionEngine }
	| {
			type: "importSrt";
			sceneId: string;
			text: string;
			settings: CaptionLayoutSettings;
			defaults: unknown;
	  }
	| {
			type: "start";
			engine?: TranscriptionEngine;
			externalConfiguration?: string;
			sceneId: string;
			language: TranscriptionLanguage;
			settings: CaptionLayoutSettings;
			defaults: unknown;
			totalDuration: number;
	  }
	| { type: "append"; index: number; words: TranscriptionWord[] }
	| { type: "restore"; snapshot: TranscriptionJob }
	| { type: "pause" | "resume" };
