import { describe, expect, test } from "bun:test";
import {
	getAiEditTimelineDuration,
	getAiEditTimelineItems,
} from "@/timeline/components/ai-edit-track-model";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

describe("AI edit timeline model", () => {
	test("normalizes canonical layers, filters scenes, and derives duration", () => {
		const items = getAiEditTimelineItems({
			activeSceneId: "scene-a",
			history: [
				{
					id: "plan-1",
					title: "Social cut",
					sceneId: "scene-a",
					layers: [
						{
							id: "range",
							operationType: "set_background_removal",
							label: "Remove background",
							reason: "Keep the presenter clean",
							anchor: {
								kind: "range",
								startTime: 100,
								duration: 500,
							},
							refs: [{ sceneId: "scene-a", elementId: "clip" }],
							operationIds: ["op-1", "op-2"],
							operationCount: 2,
							tombstone: false,
						},
						{
							id: "point",
							operationType: "split_element",
							label: "Cut",
							anchor: { kind: "point", time: 900 },
							refs: [{ sceneId: "scene-a", elementId: "clip" }],
							operationIds: ["op-3"],
							operationCount: 1,
							tombstone: false,
						},
					],
				},
				{
					id: "other-scene",
					title: "Other scene",
					sceneId: "scene-b",
					layers: [
						{
							id: "hidden",
							operationType: "future_edit",
							anchor: { kind: "point", time: 2_000 },
						},
					],
				},
			],
		});

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			planId: "plan-1",
			layerId: "range",
			operationCount: 2,
			seekTime: mediaTime({ ticks: 100 }),
			tombstone: false,
		});
		expect(items[1].seekTime).toBe(mediaTime({ ticks: 900 }));
		expect(getAiEditTimelineDuration({ items })).toBe(
			mediaTime({ ticks: 900 }),
		);
	});

	test("keeps legacy targetRefs layers visible with safe fallbacks", () => {
		const items = getAiEditTimelineItems({
			activeSceneId: "scene-a",
			history: [
				{
					layers: [
						{
							operationType: "delete_element",
							anchor: { kind: "range", startTime: -50, duration: 0 },
							targetRefs: {
								sceneId: "scene-a",
								elementId: "removed-clip",
							},
							operationIds: ["delete-1", "delete-2"],
						},
					],
				},
			],
		});

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			planId: "legacy-plan-0",
			layerId: "legacy-layer-0",
			planTitle: "AI edit",
			label: "Delete element",
			operationCount: 2,
			tombstone: true,
			anchor: { kind: "point", time: ZERO_MEDIA_TIME },
			seekTime: ZERO_MEDIA_TIME,
		});
	});

	test("ignores empty and malformed persisted history without throwing", () => {
		expect(
			getAiEditTimelineItems({ history: null, activeSceneId: "scene-a" }),
		).toEqual([]);
		expect(
			getAiEditTimelineItems({
				activeSceneId: "scene-a",
				history: [
					null,
					{ layers: "invalid" },
					{
						layers: [
							{ anchor: { kind: "point", time: 1.5 } },
							{ anchor: { kind: "range", startTime: 1 } },
						],
					},
				],
			}),
		).toEqual([]);
	});

	test("shows project activity at zero and honors scene refs without plan refs", () => {
		const items = getAiEditTimelineItems({
			activeSceneId: "scene-a",
			history: [
				{
					id: "project-plan",
					layers: [
						{
							id: "project",
							label: "Update settings",
							operationType: "set_project_settings",
							anchor: { kind: "project" },
							refs: [],
						},
						{
							id: "other-ref",
							operationType: "future_edit",
							anchor: { kind: "point", time: 100 },
							refs: [{ sceneId: "scene-b" }],
						},
					],
				},
			],
		});

		expect(items).toHaveLength(1);
		expect(items[0].anchor).toEqual({ kind: "project" });
		expect(items[0].seekTime).toBe(ZERO_MEDIA_TIME);
		expect(getAiEditTimelineDuration({ items })).toBe(ZERO_MEDIA_TIME);
	});
});
