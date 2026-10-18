import { beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { wasm } from "../../../../test-support/wasm";
import type { EditorCore } from "@/core";
import { getAutoTextsTranscriptionError } from "@/subtitles/components/auto-texts-transcription";
import { transcribeTimelineAudioBlob } from "@/transcription/server-client";
mock.module("@/media/mediabunny", () => ({
	extractTimelineAudio: () => {
		throw new Error("Inject extractAudio in manager tests");
	},
}));
mock.module("@/subtitles/insert", () => ({
	insertCaptionChunksAsTextTrack: () => {
		throw new Error("Inject insertCaptions in manager tests");
	},
}));
import type {
	AgentTaskEvent,
	AgentTaskState,
	AgentTaskTransitionDecision,
} from "opencut-wasm";

function transitionTaskForTest({
	state,
	event,
}: {
	state: AgentTaskState;
	event: AgentTaskEvent;
}): AgentTaskTransitionDecision {
	const next = { ...state };
	switch (event.type) {
		case "start":
			Object.assign(next, {
				taskId: event.taskId,
				kind: event.kind,
				status: "running",
				progressBasisPoints: 0,
				phase: event.phase,
				error: undefined,
			});
			break;
		case "progress":
			next.progressBasisPoints = event.progressBasisPoints ?? 0;
			next.phase = event.phase;
			break;
		case "request_cancel":
			next.status = "cancelling";
			next.phase = "cancelling";
			break;
		case "complete":
			next.status = "succeeded";
			next.progressBasisPoints = 10_000;
			next.phase = "complete";
			break;
		case "fail":
			next.status = "failed";
			next.error = event.error;
			break;
		case "cancel":
			next.status = "cancelled";
			next.phase = "cancelled";
			break;
		case "clear":
			return {
				allowed: true,
				reason: "accepted",
				state: {
					taskId: undefined,
					kind: undefined,
					status: "idle",
					progressBasisPoints: 0,
					phase: undefined,
					error: undefined,
				},
			};
	}
	return { allowed: true, reason: "accepted", state: next };
}

mock.module("opencut-wasm", () => ({
	...wasm,
	sampleAutomaticZoom: () => ({ scale: 1, anchorX: 0.5, anchorY: 0.5 }),
	initCompositor: () => undefined,
	getCompositorCanvas: () => null,
	getLastFrameProfile: () => null,
	releaseTexture: () => undefined,
	renderFrame: () => undefined,
	resizeCompositor: () => undefined,
	uploadTexture: () => undefined,
	applyEffectPasses: ({ source }: { source: unknown }) => source,
	applyMaskFeather: ({ mask }: { mask: unknown }) => mask,
	initializeGpu: async () => undefined,
	refineBackgroundAlpha: () => undefined,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	formatTimecode: () => "00:00:00:00",
	TICKS_PER_SECOND: 120_000,
	normalizeTextLayerWordIds: <T extends { wordRuns: Array<{ id: string }> }>(
		options: T,
	) =>
		options.wordRuns.map((word, previousWordIndex) => ({
			previousWordIndex,
			id: word.id,
		})),
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	reconcileTextContentWords: () => [],
	fitTextLayerWordsToSpan: () => [],
	textLayerDurationForWords: <
		T extends {
			duration: number;
			wordRuns: Array<{ startTime?: number; endTime?: number }>;
		},
	>(
		options: T,
	) =>
		Math.max(
			options.duration,
			...options.wordRuns.map((word) => word.endTime ?? word.startTime ?? 0),
		),
	defaultBackgroundRemovalSettings: () => ({
		enabled: false,
		mode: "remove",
		quality: "balanced",
		maskThreshold: 0.5,
		edgeContrast: 1,
		edgeFeather: 0,
		temporalSmoothing: 0,
		blurStrength: 0,
	}),
	removeCaptionWordTimeRanges: wasm.removeCaptionWordTimeRanges,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({
		clips: options.clips,
		timelineDuration: 0,
	}),
	planBackgroundRemovalDuplicate: () => ({
		kind: "existingTrack",
		trackId: "video",
	}),
	resolveBackgroundRemovalSettings: <T>(settings: T) => ({
		...settings,
		inputSize: 256,
		previewFps: 15,
		cacheEntries: 2,
		blurSigma: 0,
	}),
	transitionAgentTask: transitionTaskForTest,
}));

let TranscriptionManager: typeof import("../transcription-manager").TranscriptionManager;

beforeAll(async () => {
	({ TranscriptionManager } = await import("../transcription-manager"));
});

function createEditor() {
	const scene = {
		id: "scene-1",
		name: "Main",
		bookmarks: [],
		tracks: {
			overlay: [],
			main: {
				id: "main",
				name: "Main",
				type: "video",
				elements: [],
				muted: false,
				hidden: false,
			},
			audio: [],
			order: ["main"],
		},
	};
	return {
		scenes: {
			getActiveScene: () => scene,
			getActiveSceneOrNull: () => scene,
		},
		project: { getActive: () => ({ metadata: { id: "project-1" } }) },
		command: { getStateRevision: () => 0 },
		media: { getAssets: () => [] },
		timeline: { getTotalDuration: () => 120_000 },
	} as unknown as EditorCore;
}

describe("TranscriptionManager", () => {
	test("download file discovery cannot move canonical task progress backwards", async () => {
		const phases: string[] = [];
		const manager = new TranscriptionManager({
			editor: createEditor(),
			dependencies: {
				extractAudio: async () => new Blob(["audio"]),
				transcribe: async ({ onProgress }) => {
					for (const progress of [100, 1, 55, 100])
						onProgress?.({
							status: "loading-model",
							progress,
							message: `Downloading ${progress}`,
						});
					return {
						text: "hello",
						segments: [{ text: "hello", start: 0, end: 1 }],
						language: "en",
					};
				},
				insertCaptions: () => ["captions"],
				generateId: () => "download-task",
				transitionTask: ({ state, event }) => {
					if (event.type === "progress") {
						expect(event.progressBasisPoints!).toBeGreaterThanOrEqual(
							state.progressBasisPoints,
						);
						phases.push(event.phase!);
					}
					return transitionTaskForTest({ state, event });
				},
			},
		});
		expect((await manager.start()).task.status).toBe("succeeded");
		expect(phases).toContain("Downloading 1");
	});
	test("does not reject a transcript solely because the revision changed", async () => {
		const editor = createEditor();
		let revision = 0;
		editor.command.getStateRevision = () => revision;
		let inserted = false;
		const manager = new TranscriptionManager({
			editor,
			dependencies: {
				extractAudio: async () => new Blob(["audio"]),
				transcribe: async () => {
					revision += 1;
					return {
						text: "hello",
						segments: [{ text: "hello", start: 0, end: 1 }],
						language: "en",
					};
				},
				insertCaptions: () => {
					inserted = true;
					return ["captions"];
				},
				generateId: () => "stale-task",
				transitionTask: transitionTaskForTest,
			},
		});
		const state = await manager.start();
		expect(state.task.status).toBe("succeeded");
		expect(inserted).toBe(true);
	});
	test.each([0.5, 0, 0.0000001])(
		"normalizes provider word duration %s before durable transcript insertion",
		async (firstEnd) => {
			const inserted: Array<Record<string, unknown>> = [];
			const manager = new TranscriptionManager({
				editor: createEditor(),
				dependencies: {
					extractAudio: async () => new Blob(["audio"]),
					transcribe: async () => ({
						text: "Hello world",
						segments: [{ text: "Hello world", start: 0, end: 1 }],
						words: [
							{ text: "Hello", start: 0, end: firstEnd },
							{ text: "world", start: 0.5, end: 1 },
						],
						language: "en",
					}),
					insertCaptions: (options) => {
						inserted.push(options as unknown as Record<string, unknown>);
						return ["captions-1", "captions-2"];
					},
					generateId: () => "task-1",
					transitionTask: transitionTaskForTest,
				},
			});

			const state = await manager.start({ language: "en" });

			expect(state.task).toMatchObject({
				taskId: "task-1",
				kind: "transcription",
				status: "succeeded",
				progressBasisPoints: 10_000,
			});
			expect(state.insertedTrackIds).toEqual(["captions-1", "captions-2"]);
			expect(inserted).toHaveLength(1);
			expect(inserted[0].captionSource).toMatchObject({
				words: [
					{ text: "Hello", start: 0, end: firstEnd === 0.5 ? 0.5 : 0.001 },
					{ text: "world", start: 0.5, end: 1 },
				],
			});
			expect(JSON.stringify(state)).not.toContain("Hello world");
			expect(getAutoTextsTranscriptionError(state)).toBeNull();
		},
	);

	test("retains a service failure for Auto Texts and does not insert captions", async () => {
		const serviceError =
			"The local transcription model is unavailable. Install the Whisper model and try again.";
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ error: serviceError }, { status: 503 }),
		);
		const insertCaptions = mock(() => ["unexpected-caption-track"]);
		try {
			const manager = new TranscriptionManager({
				editor: createEditor(),
				dependencies: {
					extractAudio: async () => new Blob(["audio"]),
					transcribe: transcribeTimelineAudioBlob,
					insertCaptions,
					generateId: () => "task-failed",
					transitionTask: transitionTaskForTest,
				},
			});

			const state = await manager.start({ language: "en" });

			expect(state.task.status).toBe("failed");
			expect(getAutoTextsTranscriptionError(state)).toBe(serviceError);
			expect(state.insertedTrackIds).toEqual([]);
			expect(insertCaptions).not.toHaveBeenCalled();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("cancels during audio extraction before calling transcription", async () => {
		let resolveAudio: ((blob: Blob) => void) | undefined;
		let transcribeCalls = 0;
		const manager = new TranscriptionManager({
			editor: createEditor(),
			dependencies: {
				extractAudio: () =>
					new Promise((resolve) => {
						resolveAudio = resolve;
					}),
				transcribe: async () => {
					transcribeCalls += 1;
					return { text: "", segments: [], language: "en" };
				},
				insertCaptions: () => [],
				generateId: () => "task-2",
				transitionTask: transitionTaskForTest,
			},
		});

		const pending = manager.start({ language: "en" });
		expect(manager.getState().task.status).toBe("running");
		manager.cancel();
		expect(manager.getState().task.status).toBe("cancelling");
		resolveAudio?.(new Blob(["audio"]));

		const state = await pending;
		expect(state.task.status).toBe("cancelled");
		expect(getAutoTextsTranscriptionError(state)).toBe(
			"Transcription was cancelled.",
		);
		expect(transcribeCalls).toBe(0);
	});
});

function incrementalEditor() {
	const editor = createEditor();
	const project = {
		metadata: { id: "project-1" },
		scenes: [editor.scenes.getActiveScene()],
		transcriptionJobs: [] as import("@/transcription/job").TranscriptionJob[],
	};
	const saved: (typeof project.transcriptionJobs)[] = [];
	Object.assign(editor.project, {
		getActive: () => project,
		getActiveOrNull: () => project,
		getSessionReadOnlyReason: () => null,
		saveCurrentProject: async () => {
			await Promise.resolve();
			saved.push(structuredClone(project.transcriptionJobs));
		},
	});
	Object.assign(editor.command, {
		waitForTranscriptionPublication: async () => {},
		editTranscription: ({
			jobId,
			change,
		}: {
			jobId: string;
			change: import("@/transcription/job").TranscriptionChange;
		}) => {
			let job = project.transcriptionJobs.find((j) => j.id === jobId);
			if (change.type === "start") {
				job = {
					id: jobId,
					sceneId: change.sceneId,
					language: change.language,
					settings: change.settings,
					defaults: {},
					sourceTracks: project.scenes[0].tracks,
					sourceMedia: [],
					totalDuration: 120 * 120000,
					status: "running",
					chunks: {},
				};
				project.transcriptionJobs.push(job);
			} else if (change.type === "append") {
				job!.chunks[change.index] = change.words;
				if (Object.keys(job!.chunks).length === 2) job!.status = "complete";
			} else if (change.type === "pause") job!.status = "paused";
			else if (change.type === "resume") job!.status = "running";
			else if (change.type === "restore")
				project.transcriptionJobs.push({
					...structuredClone(change.snapshot),
					chunks: {},
					status: "running",
				});
		},
	});
	return { editor, project, saved };
}
function incrementalManager(
	editor: EditorCore,
	transcribeTimeline: NonNullable<
		import("../transcription-manager").TranscriptionManagerDependencies["transcribeTimeline"]
	>,
) {
	return new TranscriptionManager({
		editor,
		dependencies: {
			transcribeTimeline,
			extractAudio: async () => new Blob(),
			transcribe: async () => {
				throw new Error("legacy path");
			},
			insertCaptions: () => {
				throw new Error("legacy insertion");
			},
			generateId: () => "durable-job",
			transitionTask: transitionTaskForTest,
		},
	});
}
test("incremental manager persists each section and a new manager resumes only unfinished work", async () => {
	const { editor, project, saved } = incrementalEditor();
	const first = incrementalManager(editor, async ({ onChunk }) => {
		await onChunk!({ index: 0, words: [{ text: "hello", start: 1, end: 2 }] });
		expect(saved.at(-1)![0].chunks["0"][0].text).toBe("hello");
		throw new Error("renderer interrupted");
	});
	expect((await first.start()).task.status).toBe("failed");
	expect(project.transcriptionJobs[0].status).toBe("running");
	const second = incrementalManager(
		editor,
		async ({ completedChunks, onChunk }) => {
			expect(completedChunks!["0"][0].text).toBe("hello");
			const savedBeforeReplay = saved.length;
			await onChunk!({ index: 0, words: completedChunks!["0"] });
			expect(saved.length).toBe(savedBeforeReplay);
			// Undo removes a completed section while the same run is active.
			delete project.transcriptionJobs[0].chunks["0"];
			await onChunk!({ index: 0, words: completedChunks!["0"] });
			expect(saved.length).toBe(savedBeforeReplay + 1);
			expect(saved.at(-1)![0].chunks["0"][0].text).toBe("hello");
			await onChunk!({
				index: 1,
				words: [{ text: "continued", start: 61, end: 62 }],
			});
			expect(saved.at(-1)![0].status).toBe("complete");
			return {
				text: "hello continued",
				segments: [],
				words: [],
				language: "en",
			};
		},
	);
	await second.resumePending();
	expect(second.getState().task.status).toBe("succeeded");
	expect(project.transcriptionJobs).toHaveLength(1);
});
test("explicit cancellation pauses durably and does not auto-resume", async () => {
	const { editor, project, saved } = incrementalEditor();
	let manager: InstanceType<typeof TranscriptionManager>;
	manager = incrementalManager(editor, async ({ onChunk, signal }) => {
		await onChunk!({ index: 0, words: [{ text: "saved", start: 1, end: 2 }] });
		manager.cancel();
		signal!.throwIfAborted();
		throw new Error("unreachable");
	});
	expect((await manager.start()).task.status).toBe("cancelled");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(project.transcriptionJobs[0].status).toBe("paused");
	expect(saved.at(-1)![0].chunks["0"]).toHaveLength(1);
	let called = false;
	const reopened = incrementalManager(editor, async () => {
		called = true;
		throw new Error("must stay paused");
	});
	await reopened.resumePending();
	expect(called).toBe(false);
});
test("concurrent consumers share one inference and undo does not lose completed sections", async () => {
	const { editor, project } = incrementalEditor();
	let calls = 0;
	const manager = incrementalManager(editor, async ({ onChunk }) => {
		calls++;
		await onChunk!({ index: 0, words: [{ text: "first", start: 1, end: 2 }] });
		project.transcriptionJobs = [];
		await onChunk!({
			index: 1,
			words: [{ text: "second", start: 61, end: 62 }],
		});
		return { text: "first second", segments: [], language: "en" };
	});
	const a = manager.start();
	expect(manager.start()).toBe(a);
	expect((await a).task.status).toBe("succeeded");
	expect(calls).toBe(1);
	expect(Object.keys(project.transcriptionJobs[0].chunks)).toEqual(["0", "1"]);
});
