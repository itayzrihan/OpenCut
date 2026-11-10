import type { TProject } from "@/project/types";

/** Imported project metadata. Public review records remain authoritative on the server. */
export interface ClientReviewShare {
	shareId: string;
	version: string;
	sceneId: string;
	durationTicks: number;
	createdAt: string;
	title?: string;
}

export interface ClientReviewComment {
	id: string;
	shareId: string;
	shareVersion: string;
	sceneId: string;
	timeTicks: number;
	body: string;
	authorName: string;
	serverRevision: number;
	resolved: boolean;
	createdAt: string;
}

export interface ClientReviewState {
	shares: ClientReviewShare[];
	comments: ClientReviewComment[];
}

export interface ReadonlyClientReviewState {
	readonly shares: readonly Readonly<ClientReviewShare>[];
	readonly comments: readonly Readonly<ClientReviewComment>[];
}

const EMPTY_REVIEW: ReadonlyClientReviewState = Object.freeze({
	shares: Object.freeze([]),
	comments: Object.freeze([]),
});

/** Read the projected canonical TProject; callers must never mutate this value. */
export function readClientReview(
	project: TProject | null,
): ReadonlyClientReviewState {
	return project?.clientReview ?? EMPTY_REVIEW;
}

export const REVIEW_TICKS_PER_SECOND = 120_000;
