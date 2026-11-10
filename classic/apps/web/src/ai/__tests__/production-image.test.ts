import { expect, mock, test } from "bun:test";
import { mockFetch } from "@/test-support/mock-fetch";
const requests: Array<{ action?: string; data?: Record<string, unknown> }> = [];
const focus: Array<Record<string, unknown>> = [];
let native = 0;
mock.module("../local-connection", () => ({
	readLocalProvider: () => "claude",
	generateConnectedImage: async () => {
		native++;
		return {
			blob: new Blob(["fixture"], { type: "image/png" }),
			mimeType: "image/png",
		};
	},
}));
mock.module("@/generative/review-focus", () => ({
	useDirectorReviewFocus: {
		getState: () => ({
			reveal: (value: Record<string, unknown>) => focus.push(value),
		}),
	},
}));
mock.module("@/generative/client", () => ({
	fileUrl: () => "/api/generative?fixture=owned-image",
	api: async (input: { action?: string; data?: Record<string, unknown> }) => {
		requests.push(input);
		if (input.action === "prepare")
			return {
				job: {
					id: "a".repeat(32),
					digest: "b".repeat(64),
					status: "ready",
					batchId: "c".repeat(32),
					output: { id: "owned-reference" },
				},
			};
		return { batch: { id: "c".repeat(32) } };
	},
}));
const {
	generateProductionReference,
	prepareProductionReferenceBatch,
	cancelProductionReferenceBatch,
} = await import("../production-image");
test("explicit image provider does not mutate Agent selection; OpenRouter prepares frozen review only and preserves batch focus", async () => {
	const original = { window: globalThis.window, fetch: globalThis.fetch };
	Object.assign(globalThis, { window: { __opencutAccountId: "account" } });
	globalThis.fetch = mockFetch(
		async () => new Response(new Blob(["fixture PNG"], { type: "image/png" })),
	);
	try {
		const signal = new AbortController().signal;
		const item = {
			operationId: "production-one",
			prompt: "Exact reviewed shot",
			referenceIds: [],
		};
		await prepareProductionReferenceBatch({
			projectId: "p",
			items: [item],
			provider: "openrouter",
			model: "approved/image-model",
			signal,
		});
		expect(requests.map((r) => r.action)).toEqual(["prepare", "prepare-batch"]);
		expect(requests[0].data?.request).toMatchObject({
			operationId: item.operationId,
			model: "approved/image-model",
			prompt: item.prompt,
		});
		expect(requests[1].data?.batch).toMatchObject({
			kind: "images",
			jobs: [{ id: "a".repeat(32), digest: "b".repeat(64) }],
		});
		expect(focus[0].batchId).toBeDefined();
		expect(focus[0].surface).toBe("agent");
		const output = await generateProductionReference({
			projectId: "p",
			...item,
			provider: "openrouter",
			model: "approved/image-model",
			confirmed: true,
			signal,
		});
		expect(output.mimeType).toBe("image/png");
		expect(focus.at(-1)?.batchId).toBe("c".repeat(32));
		expect(requests.some((r) => r.action?.includes("approve"))).toBe(false);
		const before = requests.length;
		await prepareProductionReferenceBatch({
			projectId: "p",
			items: [item],
			provider: "codex",
			signal,
		});
		await generateProductionReference({
			projectId: "p",
			...item,
			provider: "codex",
			confirmed: true,
			signal,
		});
		expect(requests.length).toBe(before);
		expect(native).toBe(1);
		await expect(
			prepareProductionReferenceBatch({
				projectId: "p",
				items: Array.from({ length: 11 }, () => item),
				provider: "openrouter",
				signal,
			}),
		).rejects.toThrow("ten");
	} finally {
		Object.assign(globalThis, original);
	}
});
