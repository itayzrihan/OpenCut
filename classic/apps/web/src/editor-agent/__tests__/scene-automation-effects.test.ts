import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { EditingAgentHostEffect } from "@/core/agent-protocol";
const fingerprint = "a".repeat(64);
const job = {
	id: "22222222-2222-4222-8222-222222222222",
	sceneId: "scene",
	workerProjectId: "33333333-3333-4333-8333-333333333333",
	outputSceneId: "output",
	action: "sound-effects",
	status: "queued",
	sourceFingerprint: fingerprint,
};
const origin = {
	projectId: "11111111-1111-4111-8111-111111111111",
	jobId: "22222222-2222-4222-8222-222222222222",
	sceneId: "scene",
	sourceFingerprint: fingerprint,
	mediaAssetIds: [] as string[],
	fontIds: [] as string[],
};
let saved: {
	project: { metadata: { id: string }; automationSource: typeof origin };
} | null = null;
let revision = 3;
let abortOnSave = false;
let controller: AbortController;
let runs: Array<{
	id: string;
	jobs: Array<{
		projectId: string;
		sourceProjectId: string;
		automationJobId: string;
		status: string;
		completedStages: number;
		cancelRequested: boolean;
		message: string;
	}>;
}> = [];
const requests: Array<Record<string, unknown>> = [];
const saveProject = mock(async () => {
	saved = {
		project: {
			metadata: { id: "33333333-3333-4333-8333-333333333333" },
			automationSource: origin,
		},
	};
	if (abortOnSave) controller.abort();
});
const saveMediaAsset = mock(async () => {});
mock.module("@/services/storage/service", () => ({
	deserializeProject: (project: unknown) => project,
	storageService: {
		loadProject: async () => saved,
		saveProject,
		saveMediaAsset,
		loadAllMediaAssets: async () => [],
		loadAllProjectFonts: async () => [],
		saveProjectFont: async () => {},
	},
}));
mock.module("@/batch/scene-jobs", () => ({
	queueOwner: () => "44444444-4444-4444-8444-444444444444",
}));
const { performSceneAutomationEffect } =
	await import("../scene-automation-effects");
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeEach(() => {
	saved = null;
	runs = [];
	requests.length = 0;
	revision = 3;
	abortOnSave = false;
	controller = new AbortController();
	saveProject.mockClear();
	saveMediaAsset.mockClear();
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "account" },
	});
	globalThis.fetch = Object.assign(
		mock(async (_url: unknown, init?: RequestInit) => {
			if (init?.body) {
				const body = JSON.parse(String(init.body));
				requests.push(body);
				if (body.action === "scenes")
					runs = [
						{
							id: "22222222-2222-4222-8222-222222222222",
							jobs: [
								{
									projectId: "33333333-3333-4333-8333-333333333333",
									sourceProjectId: "11111111-1111-4111-8111-111111111111",
									automationJobId: "22222222-2222-4222-8222-222222222222",
									status: "ready",
									completedStages: 0,
									cancelRequested: false,
									message: "Queued",
								},
							],
						},
					];
				if (body.action === "retry") runs[0].jobs[0].status = "ready";
				if (body.action === "cancel") {
					runs[0].jobs[0].status = "cancelled";
					runs[0].jobs[0].cancelRequested = true;
				}
			}
			return Response.json({ runs });
		}),
		{ preconnect: originalFetch.preconnect },
	);
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
});
function effect(operation = "start"): EditingAgentHostEffect {
	return {
		id: 1,
		adapter: "sceneAutomation",
		projectId: "11111111-1111-4111-8111-111111111111",
		request: {
			operation,
			input: {
				projectId: "11111111-1111-4111-8111-111111111111",
				expectedRevision: 3,
				jobId: "22222222-2222-4222-8222-222222222222",
				resume: false,
			},
			job,
			worker: {
				metadata: { id: "33333333-3333-4333-8333-333333333333" },
				automationSource: origin,
			},
		},
	};
}
const flush = mock(async () => {});
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Deliberately partial host fixture; Rust validates document state in registry tests.
const editor = {
	project: {
		getActiveOrNull: () => ({
			metadata: { id: "11111111-1111-4111-8111-111111111111" },
		}),
	},
	command: { getCanonicalRevision: () => revision, flushHistory: flush },
	save: { flush },
} as unknown as EditorCore;
const perform = (value: EditingAgentHostEffect) =>
	performSceneAutomationEffect({
		effect: value,
		editor,
		accountId: "account",
		signal: controller.signal,
	});

test("starts through existing iframe queue and exact retries never overwrite the worker", async () => {
	const first = await perform(effect());
	expect(first.type).toBe("success");
	expect(saveProject).toHaveBeenCalledTimes(1);
	expect(requests).toEqual([
		{
			action: "scenes",
			projectId: "11111111-1111-4111-8111-111111111111",
			jobIds: ["22222222-2222-4222-8222-222222222222"],
			ownerId: "44444444-4444-4444-8444-444444444444",
			executor: "iframe",
		},
	]);
	await perform(effect());
	expect(saveProject).toHaveBeenCalledTimes(1);
	expect(requests).toHaveLength(1);
});
test("changed source cannot be silently recaptured before initial startup", async () => {
	const value = effect();
	value.request.worker = null;
	const result = await perform(value);
	expect(result).toMatchObject({
		type: "rejected",
		message: expect.stringContaining("Source changed"),
	});
	expect(saveProject).not.toHaveBeenCalled();
	expect(requests).toHaveLength(0);
});
test("status and cancel operate the same job without launching AI or overwriting media", async () => {
	await perform(effect());
	requests.length = 0;
	expect(await perform(effect("status"))).toMatchObject({
		type: "success",
		data: { status: "ready" },
	});
	expect(requests).toHaveLength(0);
	expect(await perform(effect("cancel"))).toMatchObject({
		type: "success",
		data: { status: "cancelled", cancelRequested: true },
	});
	expect(requests).toEqual([
		{
			action: "cancel",
			id: "22222222-2222-4222-8222-222222222222",
			projectId: "33333333-3333-4333-8333-333333333333",
		},
	]);
	expect(saveMediaAsset).not.toHaveBeenCalled();
});
test("stale revision rejects before storage or queue IO", async () => {
	revision = 4;
	expect(await perform(effect())).toMatchObject({ type: "rejected" });
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(saveProject).not.toHaveBeenCalled();
});
test("cancellation after saved worker preserves uncertainty and never launches", async () => {
	abortOnSave = true;
	await expect(perform(effect())).rejects.toThrow("Reconcile this same jobId");
	expect(saved).not.toBeNull();
	expect(requests).toHaveLength(0);
});
test("foreign execution journal rejects before retry or cancellation", async () => {
	await perform(effect());
	runs[0].jobs[0].sourceProjectId = "other";
	requests.length = 0;
	expect(await perform(effect("cancel"))).toMatchObject({ type: "rejected" });
	expect(requests).toHaveLength(0);
});
test("explicit failed-job resume preserves checkpoints and uses iframe execution", async () => {
	await perform(effect());
	runs[0].jobs[0].status = "failed";
	runs[0].jobs[0].completedStages = 5;
	requests.length = 0;
	const value = effect();
	value.request.input = {
		projectId: "11111111-1111-4111-8111-111111111111",
		expectedRevision: 3,
		jobId: "22222222-2222-4222-8222-222222222222",
		resume: true,
	};
	expect(await perform(value)).toMatchObject({
		type: "success",
		data: { status: "ready", completedStages: 5 },
	});
	expect(requests).toEqual([
		{
			action: "retry",
			id: "22222222-2222-4222-8222-222222222222",
			ownerId: "44444444-4444-4444-8444-444444444444",
			executor: "iframe",
		},
	]);
	expect(saveProject).toHaveBeenCalledTimes(1);
});

test("cancellation before any write definitively rejects without retaining uncertain work", async () => {
	controller.abort();
	expect(await perform(effect())).toMatchObject({ type: "rejected" });
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(saveProject).not.toHaveBeenCalled();
});

test("saved complete immutable worker can start after a later source edit without recapture", async () => {
	await perform(effect());
	runs = [];
	requests.length = 0;
	const value = effect();
	value.request.worker = null;
	expect(await perform(value)).toMatchObject({
		type: "success",
		data: { status: "ready" },
	});
	expect(saveProject).toHaveBeenCalledTimes(1);
	expect(saveMediaAsset).not.toHaveBeenCalled();
});
test("incomplete saved media preparation never fills from a changed source", async () => {
	await perform(effect());
	runs = [];
	requests.length = 0;
	if (!saved) throw new Error("Missing saved worker");
	saved.project.automationSource = {
		...origin,
		mediaAssetIds: ["missing-original-asset"],
	};
	const value = effect();
	value.request.worker = null;
	expect(await perform(value)).toMatchObject({
		type: "rejected",
		message: expect.stringContaining("media preparation is incomplete"),
	});
	expect(saveMediaAsset).not.toHaveBeenCalled();
	expect(requests).toHaveLength(0);
});
test("backend-incompatible identities are rejected before saving a worker", async () => {
	const value = effect();
	value.request.input = {
		projectId: "not-a-uuid",
		expectedRevision: 3,
		jobId: "job",
		resume: false,
	};
	expect(await perform(value)).toMatchObject({
		type: "rejected",
		message: expect.stringContaining("UUID"),
	});
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(saveProject).not.toHaveBeenCalled();
});
