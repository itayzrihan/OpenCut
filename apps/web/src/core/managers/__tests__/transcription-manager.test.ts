import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
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
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
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
		media: { getAssets: () => [] },
		timeline: { getTotalDuration: () => 120_000 },
	} as unknown as EditorCore;
}

describe("TranscriptionManager", () => {
	test("runs a durable transcription task and retains only safe result handles", async () => {
		const inserted: Array<Record<string, unknown>> = [];
		const manager = new TranscriptionManager({
			editor: createEditor(),
			dependencies: {
				extractAudio: async () => new Blob(["audio"]),
				transcribe: async () => ({
					text: "Hello world",
					segments: [{ text: "Hello world", start: 0, end: 1 }],
					words: [
						{ text: "Hello", start: 0, end: 0.5 },
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
		expect(JSON.stringify(state)).not.toContain("Hello world");
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
		expect(transcribeCalls).toBe(0);
	});
});
