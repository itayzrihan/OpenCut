import { beforeAll, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";

let failCorrection = false;
let hasTranscript = true;
const calls: string[] = [];
mock.module("@/commands", () => ({
	TracksSnapshotCommand: class {
		constructor(public options: unknown) {}
	},
}));
mock.module("@/subtitles/caption-tracks", () => ({
	findCaptionSourceTrack: () =>
		hasTranscript
			? {
					captionSource: {
						words: [
							{ text: "a", start: 0, end: 1 },
							{ text: "b", start: 1, end: 2 },
						],
						settings: { rows: 1, wordsPerRow: 4 },
						layerCount: 2,
					},
				}
			: null,
	rebuildCaptionTracksWithSource: ({ tracks }: { tracks: unknown }) => tracks,
}));
mock.module("@/subtitles/caption-layout", () => ({
	normalizeCaptionLayoutSettings: ({ settings }: { settings: unknown }) =>
		settings,
}));
mock.module("@/subtitles/caption-ai", () => ({
	requestTranscriptCorrection: async () => {
		calls.push("correct");
		if (failCorrection) throw new Error("Correction failed");
		return { changes: [] };
	},
	applyTranscriptCorrections: ({ words }: { words: unknown }) => ({ words }),
	requestCaptionRowRearrangement: async () => {
		calls.push("rows");
		return { rowEndPositions: [2] };
	},
	applyCaptionRowRearrangement: () => [2],
}));
mock.module("@/transitions", () => ({
	applyAndArrangeAllTextTransitions: () => calls.push("arrange"),
}));
let runAutoTexts: typeof import("../auto-texts").runAutoTexts;
beforeAll(async () => {
	({ runAutoTexts } = await import("../auto-texts"));
});
function editor({ status = "succeeded" }: { status?: string } = {}) {
	const scene = { id: "s", tracks: {} };
	return {
		transcription: {
			subscribe: () => () => {},
			getState: () => ({ task: { status: "running", phase: "transcribing" } }),
			start: async () => {
				calls.push("transcribe");
				return {
					task: {
						status,
						error: status === "failed" ? "Model failed" : undefined,
					},
				};
			},
			cancel: () => {},
		},
		project: {
			getActive: () => ({
				metadata: { id: "p" },
				settings: { canvasSize: { width: 1080, height: 1920 } },
			}),
		},
		scenes: { getActiveScene: () => scene },
		command: { execute: () => {} },
	} as unknown as EditorCore;
}
async function run({
	e,
	resumeTranscript = false,
}: {
	e: EditorCore;
	resumeTranscript?: boolean;
}) {
	return runAutoTexts({
		editor: e,
		resumeTranscript,
		signal: new AbortController().signal,
		onProgress: () => {},
		language: "he",
		settings: { rows: 1, wordsPerRow: 4 } as Parameters<
			typeof runAutoTexts
		>[0]["settings"],
	});
}
test("failed transcription stops before correction and arranging", async () => {
	calls.length = 0;
	failCorrection = false;
	await expect(run({ e: editor({ status: "failed" }) })).rejects.toThrow(
		"Model failed",
	);
	expect(calls).toEqual(["transcribe"]);
});
test("failed correction stops the recipe", async () => {
	calls.length = 0;
	failCorrection = true;
	await expect(run({ e: editor() })).rejects.toThrow("Correction failed");
	expect(calls).toEqual(["transcribe", "correct"]);
});
test("complete Auto Texts runs each stage once in order", async () => {
	calls.length = 0;
	failCorrection = false;
	await run({ e: editor() });
	expect(calls).toEqual(["transcribe", "correct", "rows", "arrange"]);
});

test("caption-stage resume reuses saved words without transcribing or inserting duplicate tracks", async () => {
	calls.length = 0;
	failCorrection = false;
	await run({ e: editor(), resumeTranscript: true });
	expect(calls).toEqual(["correct", "rows", "arrange"]);
});
test("caption-stage resume transcribes when the interrupted run saved no transcript", async () => {
	calls.length = 0;
	failCorrection = false;
	hasTranscript = false;
	try {
		await expect(run({ e: editor(), resumeTranscript: true })).rejects.toThrow(
			"No timed transcript",
		);
		expect(calls).toEqual(["transcribe"]);
	} finally {
		hasTranscript = true;
	}
});
