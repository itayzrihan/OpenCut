import { expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
const calls: string[] = [];
const stages = [
	"preflight",
	"framing",
	"silence",
	"auto-texts",
	"finish",
	"zoom",
	"transitions",
	"word-animation",
	"music",
	"save",
];
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => stages,
	compileFullAutoEdit: () => {
		throw new Error("Repeated completed stage");
	},
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: () => {},
	parseTimelineDocumentV2: () => {},
}));
mock.module("@/timeline/scenes", () => ({ updateSceneInArray: () => {} }));
mock.module("@/ai/subject-framing", () => ({
	runLocalSubjectFraming: () => {
		throw new Error("Repeated framing");
	},
}));
mock.module("@/subtitles/auto-texts", () => ({
	runAutoTexts: () => {
		throw new Error("Repeated captions");
	},
}));
mock.module("@/subtitles/caption-layout", () => ({
	DEFAULT_CAPTION_LAYOUT: {},
}));
mock.module("@/fonts/custom-fonts", () => ({
	loadProjectFont: () => {},
	isProjectFontLoaded: () => true,
}));
mock.module("@/ai/automatic-zoom", () => ({
	runAutomaticZoom: async () => {
		calls.push("zoom");
	},
}));
mock.module("@/ai/automatic-text-transitions", () => ({
	runAutomaticTextTransitions: async () => {
		calls.push("transitions");
	},
}));
mock.module("@/ai/automatic-word-animation", () => ({
	runAutomaticWordAnimation: async () => {
		calls.push("word-animation");
	},
}));
mock.module("@/ai/automatic-music", () => ({
	runAutomaticMusic: async () => {
		calls.push("music");
		return { message: "done" };
	},
}));
const { runFullAutoEdit } = await import("../full-auto-edit");
const editor = {
	project: { getActive: () => ({ metadata: { id: "original" } }) },
	scenes: { getActiveScene: () => ({ id: "scene" }) },
	save: {
		flush: async () => {
			calls.push("save");
		},
	},
} as unknown as EditorCore;
const options = {
	zoom: true,
	transitions: true,
	wordAnimation: true,
	music: true,
};
test("resume executes only remaining finishing stages on the same project", async () => {
	calls.length = 0;
	const completed: number[] = [];
	await runFullAutoEdit({
		editor,
		options,
		signal: new AbortController().signal,
		resumeFromStage: 5,
		onProgress: () => {},
		onStep: (p) => completed.push(p.completedStages),
	});
	expect(calls).toEqual([
		"zoom",
		"transitions",
		"word-animation",
		"music",
		"save",
	]);
	expect(Math.min(...completed)).toBe(5);
	expect(completed.at(-1)).toBe(10);
});
test("resume rejects incomplete caption checkpoints", async () => {
	await expect(
		runFullAutoEdit({
			editor,
			options,
			signal: new AbortController().signal,
			resumeFromStage: 3,
			onProgress: () => {},
		}),
	).rejects.toThrow("Invalid finishing checkpoint");
});
