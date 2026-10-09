/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- isolated editor/browser doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import { getPodcastTask } from "../podcast-task";
const original = { fetch: globalThis.fetch, window: globalThis.window };
afterEach(() => {
	globalThis.fetch = original.fetch;
	globalThis.window = original.window;
});
const options = {
	mode: "teaser" as const,
	minSeconds: 20,
	maxSeconds: 60,
	maxOutputs: 1,
};
function setup() {
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
	const editor = {
		project: {
			getActive: () => ({ metadata: { id: "project" } }),
			getActiveOrNull: () => ({ metadata: { id: "project" } }),
			getSessionReadOnlyReason: () => null,
		},
		scenes: { getActiveScene: () => scene, getActiveSceneOrNull: () => scene },
		command: {
			preparePodcast: () => ({
				revision: 1,
				words,
				windows: [{ index: 0, words }],
				review: () => {},
				analyzeAudio,
				apply,
			}),
			undo: () => {},
		},
		playback: { pause: () => {}, seek },
	} as unknown as EditorCore;
	return { task: getPodcastTask(editor), scene, apply, analyzeAudio, seek };
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
