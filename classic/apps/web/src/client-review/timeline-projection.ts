import {
	type ClientReviewComment,
	type ClientReviewShare,
	type ReadonlyClientReviewState,
} from "./canonical";

/** A preview timestamp is never silently transferred to another scene or render. */
export function timelineReviewProjection({
	review,
	sceneId,
	durationTicks,
}: {
	review: ReadonlyClientReviewState;
	sceneId: string;
	durationTicks: number;
}): {
	share: Readonly<ClientReviewShare> | null;
	comments: readonly Readonly<ClientReviewComment>[];
	outsideTimelineCount: number;
} {
	let share: Readonly<ClientReviewShare> | null = null;
	for (const candidate of review.shares) {
		if (candidate.sceneId !== sceneId) continue;
		if (
			!share ||
			Date.parse(candidate.createdAt) >= Date.parse(share.createdAt)
		) {
			share = candidate;
		}
	}
	if (!share) return { share: null, comments: [], outsideTimelineCount: 0 };
	const exact = review.comments.filter(
		(comment) =>
			comment.sceneId === sceneId &&
			comment.shareId === share.shareId &&
			comment.shareVersion === share.version,
	);
	return {
		share,
		comments: exact
			.filter((comment) => comment.timeTicks <= durationTicks)
			.sort((a, b) => a.timeTicks - b.timeTicks || a.id.localeCompare(b.id)),
		outsideTimelineCount: exact.filter(
			(comment) => comment.timeTicks > durationTicks,
		).length,
	};
}
