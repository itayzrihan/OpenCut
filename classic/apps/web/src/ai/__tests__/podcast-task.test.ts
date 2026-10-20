/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- isolated editor/browser doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import { getPodcastTask } from "../podcast-task";
const original = {
	fetch: globalThis.fetch,
	window: globalThis.window,
	storage: globalThis.localStorage,
};
afterEach(() => {
	globalThis.fetch = original.fetch;
	globalThis.window = original.window;
	globalThis.localStorage = original.storage;
});
const options = {
	mode: "teaser" as const,
	minSeconds: 20,
	maxSeconds: 60,
	maxOutputs: 1,
};
function setup() {
	const saved = new Map<string, string>();
	globalThis.localStorage = {
		getItem: (key: string) => saved.get(key) ?? null,
		setItem: (key: string, value: string) => {
			saved.set(key, value);
		},
		removeItem: (key: string) => {
			saved.delete(key);
		},
	} as Storage;
	globalThis.window = Object.assign(new EventTarget(), {
		__opencutAccountId: "account",
	}) as unknown as Window & typeof globalThis;
	const words = Array.from({ length: 10 }, (_, id) => ({
		id,
		sourceIndex: id,
		clipId: "clip",
		text: `word${id}`,
		start: id * 360000,
		end: id * 360000 + 120000,
	}));
	const video = {
		title: "Story",
		openingHook: "Question",
		endingHook: "Unresolved",
		confidence: 0.8,
		alternatives: [
			{
				label: "Complete",
				reason: "Coherent",
				parts: [{ firstWord: 0, lastWord: 9 }],
			},
		],
	};
	let requests = 0;
	globalThis.fetch = mock(async () =>
		++requests === 1
			? Response.json({ models: [{ id: "test" }] })
			: new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [], output_text: JSON.stringify({ videos: [video] }) } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				),
	) as unknown as typeof fetch;
	const scene = {
		id: "source",
		tracks: {
			main: { elements: [{ id: "clip", type: "video" }] },
			overlay: [{ type: "text", captionSource: {} }],
		},
	};
	const apply = mock(() => {});
	const analyzeAudio = mock(async () => []);
	const seek = mock(() => {});
	const selectedRefs: { trackId: string; elementId: string }[] = [];
	const scope = mock(() => ({
		revision: 1,
		referenceRegions: [],
		hasTranscript: true,
	}));
	const preparedIds: string[][] = [];
	const transcribe = mock(async () => ({ task: { status: "succeeded" } }));
	const editor = {
		project: {
			getActive: () => ({ metadata: { id: "project" } }),
			getActiveOrNull: () => ({ metadata: { id: "project" } }),
			getSessionReadOnlyReason: () => null,
		},
		scenes: { getActiveScene: () => scene, getActiveSceneOrNull: () => scene },
		selection: { getSelectedElements: () => selectedRefs },
		transcription: {
			start: transcribe,
			cancel: () => {},
			subscribe: () => () => {},
		},
		command: {
			podcastScope: scope,
			getCanonicalRevision: () => 1,
			planEditingProviderRetry: () => ({
				retry: false,
				delayMs: 0,
				maxAttempts: 1,
			}),
			preparePodcast: (ids: string[]) => {
				preparedIds.push(ids);
				return {
					revision: 1,
					words,
					windows: [{ index: 0, words }],
					editorial: () => ({
						policyVersion: "strategic-teaser-v1",
						complete: true,
						requests: [],
						videos: [video],
						report: {},
					}),
					review: () => {},
					analyzeAudio,
					apply,
				};
			},
			undo: () => {},
			flushHistory: async () => {},
		},
		save: { flush: async () => {} },
		playback: { pause: () => {}, seek },
	} as unknown as EditorCore;
	return {
		task: getPodcastTask(editor),
		scene,
		apply,
		analyzeAudio,
		seek,
		selectedRefs,
		scope,
		preparedIds,
		transcribe,
	};
}
test("podcast task applies once after audio and resets output playback", async () => {
	const { task, apply, analyzeAudio, seek } = setup();
	await task.start(options);
	expect(analyzeAudio).toHaveBeenCalledTimes(1);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(seek).toHaveBeenCalledWith({ time: 0 });
	expect(task.getSnapshot()).toMatchObject({
		status: "succeeded",
		outputCount: 1,
	});
});
test("cancellation during audio cannot create output scenes", async () => {
	const { task, apply, analyzeAudio } = setup();
	analyzeAudio.mockImplementation(async () => {
		task.cancel();
		return [];
	});
	await task.start(options);
	expect(apply).not.toHaveBeenCalled();
	expect(task.getSnapshot().status).toBe("cancelled");
});
test("switching the source scene while audio is decoded discards the proposal", async () => {
	const { task, scene, apply, analyzeAudio } = setup();
	analyzeAudio.mockImplementation(async () => {
		scene.id = "another-scene";
		return [];
	});
	await task.start(options);
	expect(apply).not.toHaveBeenCalled();
	expect(task.getSnapshot()).toMatchObject({
		status: "failed",
		error: "The active episode changed. No extracts were applied.",
	});
});

test("empty selection reaches canonical preparation as whole-timeline reference", async () => {
	const { task, preparedIds } = setup();
	await task.start(options);
	expect(preparedIds).toEqual([[]]);
});
test("selected clips stay frozen even when transcription changes UI selection", async () => {
	const { task, selectedRefs, scope, preparedIds, transcribe, apply } = setup();
	selectedRefs.push(
		{ trackId: "routed-camera", elementId: "camera-A" },
		{ trackId: "other-camera", elementId: "camera-C" },
	);
	scope.mockImplementation(() => ({
		revision: 1,
		referenceRegions: [],
		hasTranscript: false,
	}));
	transcribe.mockImplementation(async () => {
		selectedRefs.splice(0);
		return { task: { status: "succeeded" } };
	});
	await task.start(options);
	expect(transcribe).toHaveBeenCalledWith({
		language: "auto",
		referenceElementIds: ["camera-A", "camera-C"],
		resumeJob: undefined,
	});
	expect(preparedIds).toEqual([["camera-A", "camera-C"]]);
	expect(apply).toHaveBeenCalledTimes(1);
});

test("MCP start freezes explicit scope and exact retries never apply a second edit", async () => {
	const { task, scene, selectedRefs, preparedIds, apply } = setup();
	selectedRefs.push({
		trackId: "ignored-ui-selection",
		elementId: "unselected",
	});
	const input = {
		...options,
		sceneId: "source",
		elementIds: [],
		requestId: "mcp-request",
	};
	task.startRemote(input);
	task.startRemote(input);
	if (task.getSnapshot().status === "running")
		await new Promise<void>((resolve) => {
			const off = task.subscribe(() => {
				if (task.getSnapshot().status !== "running") {
					off();
					resolve();
				}
			});
		});
	expect(task.getSnapshot()).toMatchObject({
		status: "succeeded",
		requestId: "mcp-request",
		projectId: "project",
		sceneId: "source",
	});
	scene.id = "created-output";
	task.startRemote(input);
	expect(preparedIds).toEqual([[]]);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(() => task.startRemote({ ...input, elementIds: ["other"] })).toThrow(
		"different inputs",
	);
});
