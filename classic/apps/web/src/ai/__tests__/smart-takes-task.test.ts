/* eslint-disable opencut/prefer-object-params -- Browser API doubles use native positional signatures. */
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- browser/transport doubles. */
import { afterEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SmartTakesTask } from "../smart-takes-task";
const plan = {
	groups: [
		{
			label: "Opening",
			confidence: 0.9,
			selected: 0,
			alternatives: [
				{
					label: "Take",
					reason: "Complete",
					parts: [{ firstWord: 0, lastWord: 0 }],
				},
			],
		},
	],
	discarded: [],
};
const words = [
	{
		id: 0,
		sourceIndex: 0,
		clipId: "clip",
		text: "Hello",
		start: 0,
		end: 120000,
	},
];
const original = {
	fetch: globalThis.fetch,
	window: globalThis.window,
	storage: globalThis.sessionStorage,
};
afterEach(() => {
	globalThis.fetch = original.fetch;
	globalThis.window = original.window;
	globalThis.sessionStorage = original.storage;
});
function setup() {
	globalThis.window = Object.assign(new EventTarget(), {
		__opencutAccountId: "account",
	}) as unknown as Window & typeof globalThis;
	const values = new Map<string, string>();
	globalThis.sessionStorage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	} as Storage;
	let requests = 0;
	globalThis.fetch = mock(async () => {
		requests++;
		if (requests === 1) return Response.json({ models: [{ id: "model" }] });
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output_text: requests === 2 ? "analysis" : JSON.stringify(plan), output: [] } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}) as unknown as typeof fetch;
	const apply = mock(() => {});
	const analyzeAudio = mock(async () => []);
	const scene = {
		id: "scene",
		tracks: {
			main: { elements: [{ id: "clip", type: "video" }] },
			overlay: [
				{ type: "text", captionSource: { words: [{ text: "Hello" }] } },
			],
		},
	};
	const editor = {
		project: {
			getActive: () => ({ metadata: { id: "project" } }),
			getActiveOrNull: () => ({ metadata: { id: "project" } }),
			getSessionReadOnlyReason: () => null,
		},
		scenes: { getActiveScene: () => scene, getActiveSceneOrNull: () => scene },
		command: {
			prepareSmartTakes: () => ({
				words,
				revision: 1,
				apply,
				analyzeAudio,
			}),
			undo: () => {},
		},
	} as unknown as EditorCore;
	return { editor, apply, analyzeAudio, scene, requests: () => requests };
}
async function finished(task: SmartTakesTask) {
	if (task.getSnapshot().status !== "running") return;
	await new Promise<void>((resolve) => {
		const unsubscribe = task.subscribe(() => {
			if (task.getSnapshot().status !== "running") {
				unsubscribe();
				resolve();
			}
		});
	});
}
test("start is nonblocking and idempotent; a failed apply resumes the saved plan without inference", async () => {
	const { editor, apply, requests } = setup();
	apply.mockImplementation(() => {
		throw new Error("invalid input: overlap");
	});
	const task = new SmartTakesTask({ editor: editor });
	const input = {
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "request-1",
	};
	expect(task.start(input).status).toBe("running");
	expect(task.start(input).status).toBe("running");
	expect(() => task.start({ ...input, elementIds: ["different"] })).toThrow(
		"different inputs",
	);
	await finished(task);
	expect(requests()).toBe(4);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(task.read()).toMatchObject({
		status: "failed",
		stage: "Applying take plan",
		error: "invalid input: overlap",
		hasCheckpoint: true,
	});
	expect(task.read(true)).toMatchObject({ checkpoint: { plan }, words });
	apply.mockImplementation(() => {});
	const reopened = new SmartTakesTask({ editor: editor });
	reopened.start({ ...input, requestId: "retry" });
	await finished(reopened);
	expect(reopened.read()).toMatchObject({ status: "succeeded", groupCount: 1 });
	expect(requests()).toBe(4);
	expect(apply).toHaveBeenCalledTimes(2);
});
test("changed source invalidates saved output; another account cannot read diagnostics", async () => {
	const { editor, scene, requests } = setup();
	const task = new SmartTakesTask({ editor: editor });
	task.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "first",
	});
	await finished(task);
	window.__opencutAccountId = "other";
	expect(task.read(true)).toEqual({ status: "idle" });
	window.__opencutAccountId = "account";
	scene.tracks.main.elements.push({ id: "new-clip", type: "video" });
	const reopened = new SmartTakesTask({ editor: editor });
	reopened.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "second",
	});
	await finished(reopened);
	// Provider deliberately supplies models only once: requesting them again
	// proves the final plan was invalidated before any second application.
	expect(requests()).toBe(5);
	expect(reopened.read()).toMatchObject({ status: "failed" });
});
test("cancelling analysis prevents apply", async () => {
	const { editor, apply } = setup();
	globalThis.fetch = mock(
		(_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("Aborted", "AbortError")),
				);
			}),
	) as unknown as typeof fetch;
	const task = new SmartTakesTask({ editor: editor });
	task.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "cancel",
	});
	task.cancel();
	await finished(task);
	expect(task.read()).toMatchObject({ status: "cancelled" });
	expect(apply).not.toHaveBeenCalled();
});

test("audio decode failure leaves the timeline untouched and retries the saved plan", async () => {
	const { editor, apply, analyzeAudio, requests } = setup();
	analyzeAudio.mockImplementation(async () => {
		throw new Error("Source audio unavailable");
	});
	const task = new SmartTakesTask({ editor: editor });
	task.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "audio-failure",
	});
	await finished(task);
	expect(task.read()).toMatchObject({
		status: "failed",
		stage: "Checking audio and protecting word boundaries",
		hasCheckpoint: true,
	});
	expect(apply).not.toHaveBeenCalled();
	analyzeAudio.mockImplementation(async () => []);
	task.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "audio-retry",
	});
	await finished(task);
	expect(task.read()).toMatchObject({ status: "succeeded" });
	expect(requests()).toBe(4);
	expect(apply).toHaveBeenCalledWith({
		plan,
		audioEvidence: [],
		execution: expect.objectContaining({
			mode: "standard",
			runMetrics: expect.objectContaining({ elapsedMs: expect.any(Number) }),
		}),
	});
});

test("cancelling during audio analysis never applies the completed AI plan", async () => {
	const { editor, apply, analyzeAudio } = setup();
	let release!: (value: never[]) => void;
	let started!: () => void;
	const decoding = new Promise<void>((resolve) => {
		started = resolve;
	});
	analyzeAudio.mockImplementation(() => {
		started();
		return new Promise<never[]>((resolve) => {
			release = resolve;
		});
	});
	const task = new SmartTakesTask({ editor: editor });
	task.start({
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "cancel-audio",
	});
	await decoding;
	task.cancel();
	release([]);
	await finished(task);
	expect(task.read()).toMatchObject({
		status: "cancelled",
		hasCheckpoint: true,
	});
	expect(apply).not.toHaveBeenCalled();
});

test("mode is part of retry identity and checkpoints stay isolated across modes", async () => {
	const { editor, requests } = setup();
	const task = new SmartTakesTask({ editor: editor });
	const input = {
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "standard",
	};
	task.start(input);
	expect(() => task.start({ ...input, mode: "experimental" })).toThrow(
		"different inputs",
	);
	await finished(task);
	expect(task.read()).toMatchObject({
		mode: "standard",
		elapsedMs: expect.any(Number),
	});
	expect(
		task
			.getSnapshot()
			.stageTimings?.some((s) => s.stage === "Applying take plan"),
	).toBe(true);
	const next = new SmartTakesTask({ editor: editor });
	next.start({ ...input, requestId: "experimental", mode: "experimental" });
	await finished(next);
	// This stub only supplies models once: a new model request proves that the
	// standard checkpoint was not reused by experimental mode.
	expect(requests()).toBe(5);
	expect(next.read()).toMatchObject({ mode: "experimental", status: "failed" });
});

test("new runs default to the faster mode", async () => {
	const { editor } = setup();
	const task = new SmartTakesTask({ editor: editor });
	expect(
		task.start({ elementIds: ["clip"], requestId: "fast-default" }).mode,
	).toBe("experimental");
	task.cancel();
	await finished(task);
});

test("missing transcript is generated and corrected before capturing the canonical take source", async () => {
	const { editor, scene, apply } = setup();
	scene.tracks.overlay = [];
	const steps: string[] = [];
	const prepare = editor.command.prepareSmartTakes.bind(editor.command);
	editor.command.prepareSmartTakes = (ids) => {
		steps.push("prepare");
		return { ...prepare(ids), words: [{ ...words[0], text: "Corrected" }] };
	};
	let release!: () => void;
	const task = new SmartTakesTask({
		editor: editor,
		prepareTranscript: async ({ onProgress }) => {
			onProgress("Generating transcript");
			steps.push("transcribe");
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			onProgress("Codex correcting transcript");
			steps.push("correct");
		},
	});
	const input = {
		mode: "standard" as const,
		elementIds: ["clip"],
		requestId: "prepare",
	};
	task.start(input);
	task.start(input);
	expect(steps).toEqual(["transcribe"]);
	expect(task.getSnapshot().stage).toBe("Generating transcript");
	release();
	await finished(task);
	expect(steps).toEqual(["transcribe", "correct", "prepare"]);
	expect(task.read(true)).toMatchObject({
		status: "succeeded",
		words: [{ text: "Corrected" }],
	});
	expect(apply).toHaveBeenCalledTimes(1);
});

test("existing transcript skips preparation", async () => {
	const { editor } = setup();
	const prepare = mock(async () => {});
	const task = new SmartTakesTask({
		editor: editor,
		prepareTranscript: prepare,
	});
	task.start({ mode: "standard", elementIds: ["clip"], requestId: "existing" });
	await finished(task);
	expect(prepare).not.toHaveBeenCalled();
	expect(task.read()).toMatchObject({ status: "succeeded" });
});

test("correction failure stops analysis and retry still corrects the newly saved transcript", async () => {
	const { editor, scene, requests, apply } = setup();
	scene.tracks.overlay = [];
	let attempts = 0;
	const task = new SmartTakesTask({
		editor: editor,
		prepareTranscript: async ({ onProgress, resumeTranscript }) => {
			expect(resumeTranscript).toBe(true);
			attempts++;
			scene.tracks.overlay = [
				{ type: "text", captionSource: { words: [{ text: "Raw" }] } },
			];
			onProgress("Codex correcting transcript");
			if (attempts === 1) throw new Error("Correction failed");
		},
	});
	task.start({
		mode: "standard",
		elementIds: ["clip"],
		requestId: "fail-correction",
	});
	await finished(task);
	expect(task.read()).toMatchObject({
		status: "failed",
		stage: "Codex correcting transcript",
	});
	expect(requests()).toBe(0);
	expect(apply).not.toHaveBeenCalled();
	task.start({
		mode: "standard",
		elementIds: ["clip"],
		requestId: "retry-correction",
	});
	await finished(task);
	expect(attempts).toBe(2);
	expect(task.read()).toMatchObject({ status: "succeeded" });
});

test("cancelling preparation propagates the signal and never starts take analysis", async () => {
	const { editor, scene, apply, requests } = setup();
	scene.tracks.overlay = [];
	let cancelled = false;
	const task = new SmartTakesTask({
		editor: editor,
		prepareTranscript: async ({ signal }) => {
			await new Promise<void>((_resolve, reject) =>
				signal.addEventListener(
					"abort",
					() => {
						cancelled = true;
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				),
			);
		},
	});
	task.start({ elementIds: ["clip"], requestId: "cancel-preparation" });
	task.cancel();
	await finished(task);
	expect(cancelled).toBe(true);
	expect(task.read()).toMatchObject({ status: "cancelled" });
	expect(requests()).toBe(0);
	expect(apply).not.toHaveBeenCalled();
});

test("switching account during preparation never analyzes or applies the previous account's transcript", async () => {
	const { editor, scene, apply, requests } = setup();
	scene.tracks.overlay = [];
	let release!: () => void;
	const task = new SmartTakesTask({
		editor: editor,
		prepareTranscript: () =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	});
	task.start({ elementIds: ["clip"], requestId: "account-change" });
	window.__opencutAccountId = "other";
	release();
	await finished(task);
	expect(task.getSnapshot().status).toBe("failed");
	expect(requests()).toBe(0);
	expect(apply).not.toHaveBeenCalled();
});
