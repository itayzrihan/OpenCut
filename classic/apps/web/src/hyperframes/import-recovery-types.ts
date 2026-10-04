import type { HyperframesSource } from "./types";
import type { MediaAsset } from "@/media/types";

/** A pending filesystem operation. The canonical runtime still owns the edit. */
export interface HyperframesImportDraft {
	kind: "hyperframes";
	name: string;
	sceneId: string;
	startSeconds?: number;
	source: HyperframesSource;
	resources: Array<
		Pick<
			MediaAsset,
			"id" | "name" | "type" | "size" | "lastModified" | "fileName" | "mimeType"
		>
	>;
}

export interface HyperframesImportRecovery {
	uploadToken: string;
	createdAt: string;
	draft: HyperframesImportDraft;
	/** Only complete files still owned by this attempt are ready to reuse. */
	readyAssetIds: string[];
}

export interface HyperframesImportRecoverySummary {
	uploadToken: string;
	createdAt: string;
	name: string;
	sceneId: string;
	completed: number;
	total: number;
}
