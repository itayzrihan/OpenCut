import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { ExportOptions } from "@/export";
export type RenderJob = {
	id: string;
	projectId: string;
	sceneId: string;
	sourceRevision: number;
	snapshot: CanonicalClassicSnapshot;
	snapshotHash: string;
	options: Required<ExportOptions>;
	status: "queued" | "rendering" | "completed" | "failed" | "cancelled";
	createdAtMs: number;
	updatedAtMs: number;
	progress: number;
	message: string;
	attempt: string | null;
	cancelRequested: boolean;
	outputId: string | null;
};
export type RenderJobView = Omit<RenderJob, "snapshot" | "attempt"> & {
	projectName: string;
	sceneName: string;
};
export type RenderQueueView = { revision: number; jobs: RenderJobView[] };
