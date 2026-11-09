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
	replacement?: ReplaceTarget;
	referenceImage?: true;
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
