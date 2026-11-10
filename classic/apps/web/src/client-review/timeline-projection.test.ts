import { describe, expect, test } from "bun:test";
import { timelineReviewProjection } from "./timeline-projection";
import type { ClientReviewComment, ClientReviewShare } from "./canonical";

const first: ClientReviewShare = {
	shareId: "a",
	version: "v1",
	sceneId: "scene-a",
	durationTicks: 1_200_000,
	createdAt: "2026-11-10T10:00:00Z",
};
const latest: ClientReviewShare = {
	...first,
	version: "v2",
	createdAt: "2026-11-10T10:01:00Z",
};
const another: ClientReviewShare = {
	...latest,
	shareId: "b",
	sceneId: "scene-b",
	createdAt: "2026-11-10T10:02:00Z",
};
function comment({
	id,
	share,
	ticks,
}: {
	id: string;
	share: ClientReviewShare;
	ticks: number;
}): ClientReviewComment {
	return {
		id,
		shareId: share.shareId,
		shareVersion: share.version,
		sceneId: share.sceneId,
		timeTicks: ticks,
		body: "Keep this moment",
		authorName: "Client",
		serverRevision: 1,
		resolved: false,
		createdAt: share.createdAt,
	};
}

describe("timeline feedback projection", () => {
	test("shows only exact latest render and active scene without remapping truncated times", () => {
		const comments = [
			comment({ id: "old", share: first, ticks: 10 }),
			comment({ id: "other-scene", share: another, ticks: 20 }),
			comment({ id: "end", share: latest, ticks: 600_000 }),
			comment({ id: "after-end", share: latest, ticks: 600_001 }),
			comment({ id: "start", share: latest, ticks: 0 }),
		];
		const original = structuredClone(comments);
		const result = timelineReviewProjection({
			review: { shares: [latest, another, first], comments },
			sceneId: "scene-a",
			durationTicks: 600_000,
		});
		expect(result.share?.version).toBe("v2");
		expect(result.comments.map((item) => item.id)).toEqual(["start", "end"]);
		expect(result.outsideTimelineCount).toBe(1);
		expect(comments).toEqual(original);
	});
	test("never falls back to stale feedback on a newer render without comments", () => {
		const result = timelineReviewProjection({
			review: {
				shares: [first, latest],
				comments: [comment({ id: "old", share: first, ticks: 10 })],
			},
			sceneId: "scene-a",
			durationTicks: 1_200_000,
		});
		expect(result.share?.version).toBe("v2");
		expect(result.comments).toEqual([]);
		expect(
			timelineReviewProjection({
				review: { shares: [first], comments: [] },
				sceneId: "deleted-scene",
				durationTicks: 1,
			}).share,
		).toBeNull();
	});
});
