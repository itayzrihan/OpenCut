import { expect, test } from "bun:test";
import { performGenerativeReviewEffect } from "./host-effect";
import { useDirectorReviewFocus } from "./review-focus";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
test("external preparation opens Generative exact-review focus without approving and rejects stale account", async () => {
	const oldFetch = globalThis.fetch,
		oldWindow = globalThis.window;
	Object.defineProperty(globalThis, "window", {
		value: { __opencutAccountId: "account-a" },
		configurable: true,
		writable: true,
	});
	const effect = {
		id: 1,
		adapter: "generativeReview",
		projectId: "project-a",
		request: {
			projectId: "project-a",
			expectedRevision: 4,
			operationId: "request-1",
			operation: { type: "prepare" },
		},
	};
	const calls: string[] = [];
	try {
		globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
			const [url, init] = args;
			calls.push(String(url));
			expect(String(url)).toBe("/api/generative/mcp");
			expect(init?.body).not.toContain("approve");
			return Response.json({
				projectId: "project-a",
				revision: 4,
				reference: null,
				job: {
					id: "a".repeat(32),
					digest: "b".repeat(64),
					status: "review",
					mediaId: null,
				},
				jobs: [],
			});
		};
		const args = {
			effect,
			accountId: "account-a",
			signal: new AbortController().signal,
			activeProjectId: () => "project-a",
			currentRevision: () => 4,
		};
		const result = await performGenerativeReviewEffect(args);
		expect(result.type).toBe("success");
		expect(useAssetsPanelStore.getState().activeTab).toBe("generative");
		expect(useDirectorReviewFocus.getState().jobId).toBe("a".repeat(32));
		await expect(
			performGenerativeReviewEffect({ ...args, accountId: "other" }),
		).rejects.toThrow("changed");
		expect(calls).toHaveLength(1);
	} finally {
		globalThis.fetch = oldFetch;
		Object.defineProperty(globalThis, "window", {
			value: oldWindow,
			configurable: true,
			writable: true,
		});
		useDirectorReviewFocus.getState().clear();
	}
});
