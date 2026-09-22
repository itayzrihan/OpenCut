import type { FullAutoOptions } from "@/ai/full-auto-edit";
export type BatchJobStatus =
	| "queued"
	| "importing"
	| "ready"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";
export interface BatchJob {
	source?: "existing" | "import";
	projectId: string;
	name: string;
	fileName: string;
	status: BatchJobStatus;
	message: string;
	cancelRequested: boolean;
	created: boolean;
	completedStages: number;
}
export interface BatchRun {
	kind?: "single" | "batch";
	createdAt?: number;
	id: string;
	options: FullAutoOptions;
	jobs: BatchJob[];
	updatedAt: number;
}
export interface BatchState {
	executionRunId?: string;
	runs: BatchRun[];
}

export type BatchSource = File | { name: string; sourcePath: string };
