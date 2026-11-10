import type { ScriptContent } from "@/production-studio/types";
export interface DirectorReference {
	id: string;
	name: string;
	kind: "image" | "audio" | "video";
	mime: string;
	bytes: number;
	storyboard: boolean;
}
export interface DirectorMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}
export interface DirectorJobLink {
	id: string;
	digest: string;
	status: string;
	mediaId?: string | null;
}
export interface DirectorDocument {
	messages: DirectorMessage[];
	references: DirectorReference[];
	direction: string;
	transcript: string;
	jobs: DirectorJobLink[];
	storyboard?: ClientStoryboard | null;
	chapterPlans?: ChapterPlan[];
	productionHandoff?: {
		id: string;
		sourceRevision: number;
		createdAt: string;
		request: string;
		rows: { rowId: string; version: number; content: ScriptContent }[];
		referenceSlots: {
			slotId: string;
			slotVersion: number;
			version: number;
			referenceId: string;
		}[];
		referenceIds: string[];
		durationMs: number;
		storyboardRecommended: boolean;
	} | null;
}
export interface ClientStoryboardScene {
	id: string;
	title: string;
	description: string;
	startSeconds?: number | null;
	endSeconds?: number | null;
	imageReferenceId?: string | null;
}
export interface ClientStoryboard {
	title: string;
	summary: string;
	sheetReferenceIds: string[];
	scenes: ClientStoryboardScene[];
}
export interface DirectorJob {
	id: string;
	projectId: string;
	kind: "video" | "storyboard";
	status: string;
	digest: string;
	prompt: string;
	model: string;
	provider?: "chatgpt";
	seamless?: SeamlessTarget;
	batchId?: string;
	replacement?: ReplaceTarget;
	referenceImage?: true;
	videoMode?: "text" | "references" | "frames";
	chapter?: {
		planId: string;
		planVersion: number;
		chapterId: string;
		index: number;
		total: number;
		title: string;
		sourceStartMs?: number;
		sourceEndMs?: number;
		timingEstimated?: boolean;
	};
	duration?: number;
	resolution?: string;
	aspectRatio?: string;
	references: DirectorReference[];
	createdAt: number;
	submittedAt?: number;
	providerId?: string;
	providerStatus?:
		| "pending"
		| "in_progress"
		| "completed"
		| "failed"
		| "cancelled"
		| "expired";
	providerStatusAt?: number;
	message: string;
	cost?: number;
	output?: DirectorReference;
}
export interface SeamlessTarget {
	sceneId: string;
	trackId: string;
	leftId: string;
	rightId: string;
	anchor: string;
}
export type ReplaceMode = "full" | "refine";
export interface ReplaceTarget {
	sceneId: string;
	trackId: string;
	elementId: string;
	anchor: string;
	durationTicks: number;
	mode: ReplaceMode;
}
export interface DirectorStatus {
	configured: boolean;
	sessionSeconds: number;
	jobs: DirectorJob[];
	publicOrigin: string | null;
}

export interface ChapterPlan {
	directionDigest: string;
	id: string;
	title: string;
	version: number;
	model: string;
	resolution: string;
	aspectRatio: string;
	references: {
		id: string;
		slotVersion: number;
		version: number;
		referenceId: string;
	}[];
	chapters: {
		id: string;
		title: string;
		source: { id: string; version: number; digest: string };
		sourceStartMs: number;
		sourceEndMs: number;
		timingEstimated: boolean;
		sourceText: string;
		latinTransliteration: string;
		visualDescription: string;
		prompt: string;
		duration: number;
	}[];
	batchId?: string | null;
	jobIds: string[];
}
export interface DirectorBatch {
	id: string;
	projectId: string;
	kind: "chapters" | "seamless" | "images";
	digest: string;
	jobs: { id: string; digest: string }[];
	createdAt: number;
	status: "review" | "running" | "complete" | "paused" | "cancelled";
	message: string;
}
