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
	id: string;
	options: FullAutoOptions;
	jobs: BatchJob[];
	updatedAt: number;
}
export interface BatchState {
	runs: BatchRun[];
}

export type BatchSource = File | { name: string; sourcePath: string };

export interface SingleEditProgress {
	updatedAt: number;
	id: string;
	projectId: string;
	name: string;
	options: FullAutoOptions;
	status: "running" | "completed" | "failed" | "cancelled";
	completedStages: number;
	message: string;
	cancel: () => void;
}
