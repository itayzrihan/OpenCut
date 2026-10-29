/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal injected editor/IO fixtures; native preparation is covered through the registry. */
import { expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";

const source = {
	id: "scene",
	tracks: {
		main: { id: "main", elements: [] as Array<{ id: string }>, muted: false },
		overlay: [
			{
				id: "camera",
				type: "video",
				elements: [
					{
						id: "chosen",
						type: "video",
						enabled: true,
						isSourceAudioEnabled: false,
					},
				],
			},
			{
				id: "captions",
				type: "text",
				elements: [{ id: "caption" }],
				captionSource: { words: [{ text: "saved speech" }] },
			},
		],
		audio: [
			{
				id: "mic",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "audio",
						type: "audio",
						params: { volume: 15, noiseReduction: 100 },
					},
				],
			},
		],
	},
};
let scene: typeof source;
let cancelled = false;
const calls: string[] = [];
const unexpected = () => {
	throw new Error("Unexpected media or AI stage");
};
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => ["preflight", "silence", "auto-texts", "save"],
	compileFullAutoEdit: unexpected,
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: unexpected,
	parseTimelineDocumentV2: unexpected,
}));
mock.module("@/timeline/scenes", () => ({ updateSceneInArray: unexpected }));
mock.module("@/ai/subject-framing", () => ({
	runLocalSubjectFraming: unexpected,
}));
mock.module("@/ai/automatic-music", () => ({ runAutomaticMusic: unexpected }));
mock.module("@/ai/automatic-zoom", () => ({ runAutomaticZoom: unexpected }));
mock.module("@/ai/automatic-text-transitions", () => ({
	runAutomaticTextTransitions: unexpected,
}));
mock.module("@/ai/automatic-sound-effects", () => ({
	runAutomaticSoundEffects: async () => ({
		soundCount: 0,
		summary: "No accents",
	}),
}));
mock.module("@/ai/automatic-word-animation", () => ({
	runAutomaticWordAnimation: unexpected,
}));
mock.module("@/subtitles/caption-layout", () => ({
	DEFAULT_CAPTION_LAYOUT: {},
}));
mock.module("@/fonts/custom-fonts", () => ({
	loadProjectFont: async () => {},
	isProjectFontLoaded: () => !cancelled,
}));
mock.module("@/services/transcription/service", () => ({
	assertBrowserTranscriptionAvailable: () => {},
}));
mock.module("@/subtitles/auto-texts", () => ({
	runAutoTexts: async ({ resumeTranscript }: { resumeTranscript: boolean }) => {
		expect(resumeTranscript).toBe(true);
		expect(scene.tracks.overlay[1].captionSource?.words).toEqual(
			source.tracks.overlay[1].captionSource?.words,
		);
		calls.push("saved-transcript");
	},
}));
mock.module("@/batch/scene-jobs", () => ({
	automationControl: ({ change }: { change: { type: string } }) => {
		if (change.type === "prepare") {
			calls.push("prepare-worker");
			scene.tracks.main.elements = [...scene.tracks.overlay[0].elements];
			scene.tracks.overlay[0].elements = [];
		} else calls.push("checkpoint");
	},
}));
const { runFullAutoEdit } = await import("../full-auto-edit");
function editor() {
	const project = {
		metadata: { id: "worker" },
		automationCheckpoint: 0,
		customFonts: [{ family: "Assistant Bold" }],
	};
	return {
		project: { getActive: () => project, getActiveOrNull: () => project },
		scenes: { getActiveScene: () => scene },
		command: { getStateRevision: () => 1, flushHistory: async () => {} },
		save: { flush: async () => {} },
		timeline: {
			removeAllSilence: () => {
				throw Error(
					"Must not cut the muted camera audio instead of the microphones",
				);
			},
		},
	} as unknown as EditorCore;
}
test("isolated routed scene keeps transcript and microphone routing through Full Auto Edit", async () => {
	calls.length = 0;
	cancelled = false;
	scene = structuredClone(source);
	const notes = await runFullAutoEdit({
		editor: editor(),
		signal: new AbortController().signal,
		options: {
			zoom: false,
			music: false,
			transitions: false,
			wordAnimation: false,
		},
		onProgress: () => {},
	});
	expect(calls[0]).toBe("prepare-worker");
	expect(calls).toContain("saved-transcript");
	expect(calls.filter((x) => x === "checkpoint")).toHaveLength(4);
	expect(scene.tracks.audio).toEqual(source.tracks.audio);
	expect(source.tracks.main.elements).toEqual([]);
	expect(notes.some((x) => x.includes("synchronized microphone mix"))).toBe(
		true,
	);
});
test("font preflight failure never prepares or changes the captured scene", async () => {
	calls.length = 0;
	cancelled = true;
	scene = structuredClone(source);
	await expect(
		runFullAutoEdit({
			editor: editor(),
			signal: new AbortController().signal,
			options: {
				zoom: false,
				music: false,
				transitions: false,
				wordAnimation: false,
			},
			onProgress: () => {},
		}),
	).rejects.toThrow("font file is unavailable");
	expect(calls).toEqual([]);
	expect(scene).toEqual(source);
	cancelled = false;
});
