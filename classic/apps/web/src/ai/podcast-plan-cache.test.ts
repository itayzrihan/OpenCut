import { expect, test } from "bun:test";
import {
	podcastPlanCacheKey,
	readPodcastPlan,
	savePodcastPlan,
} from "./podcast-plan-cache";
test("resume proposals are scoped to account, project, source words and options; corrupt data is not reused", async () => {
	const input = {
		account: "a",
		projectId: "p",
		sceneId: "s",
		options: {
			mode: "highlights" as const,
			minSeconds: 20,
			maxSeconds: 90,
			maxOutputs: 7,
		},
		words: [],
	};
	const key = await podcastPlanCacheKey(input);
	expect(key).toStartWith("opencut-podcast-shorts-v2:");
	expect(await podcastPlanCacheKey({ ...input, account: "b" })).not.toBe(key);
	expect(await podcastPlanCacheKey({ ...input, projectId: "other" })).not.toBe(
		key,
	);
	expect(
		await podcastPlanCacheKey({
			...input,
			options: { ...input.options, maxOutputs: 1 },
		}),
	).not.toBe(key);
	expect(
		await podcastPlanCacheKey({
			...input,
			sourceFingerprint: "changed-source-media-or-captions",
		}),
	).not.toBe(key);
	expect(
		await podcastPlanCacheKey({
			...input,
			options: { ...input.options, mode: "teaser" },
		}),
	).toStartWith("opencut-strategic-teaser-v1:");
	const data = new Map<string, string>();
	const storage = {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			data.set(k, v);
		},
	};
	const videos = [
		{
			title: "Test",
			openingHook: "Opening",
			endingHook: "End",
			confidence: 0.9,
			alternatives: [
				{
					label: "First",
					reason: "Complete",
					parts: [{ firstWord: 0, lastWord: 15 }],
				},
			],
		},
	];
	savePodcastPlan(storage, key, videos);
	expect(readPodcastPlan(storage, key)).toEqual(videos);
	expect(readPodcastPlan(storage, "other")).toBeNull();
	data.set(key, "invalid");
	expect(readPodcastPlan(storage, key)).toBeNull();
});
test("teleprompter policy cache preserves independent per-sentence choices and explicit omissions", async () => {
	const key = await podcastPlanCacheKey({
		account: "a",
		projectId: "p",
		sceneId: "s",
		options: {
			mode: "teleprompter",
			minSeconds: 0,
			maxSeconds: 0,
			maxOutputs: 32,
		},
		words: [],
	});
	expect(key).toStartWith("opencut-teleprompter-v1:");
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
	};
	const videos = [
		{
			title: "תסריט מלא",
			openingHook: "פתיחה",
			endingHook: "סיום",
			confidence: 0.9,
			alternatives: [],
			groups: [
				{
					label: "משפט",
					confidence: 0.9,
					selected: 1,
					alternatives: [
						{
							label: "ראשון",
							reason: "מלא",
							parts: [{ firstWord: 0, lastWord: 3 }],
						},
						{
							label: "שני",
							reason: "מדויק",
							parts: [{ firstWord: 4, lastWord: 8 }],
						},
					],
				},
			],
			discarded: [{ firstWord: 9, lastWord: 9, reason: "הוראת צילום" }],
		},
	];
	savePodcastPlan(storage, key, videos);
	expect(readPodcastPlan(storage, key)).toEqual(videos);
});
