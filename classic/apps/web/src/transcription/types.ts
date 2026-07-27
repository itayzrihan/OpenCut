import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptionWord {
	text: string;
	start: number;
	end: number;
	source?: {
		type: "text-layer";
		trackId: string;
		elementId: string;
		wordIndex: number;
		wordId?: string;
	};
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	words?: TranscriptionWord[];
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
	words?: TranscriptionWord[];
}
