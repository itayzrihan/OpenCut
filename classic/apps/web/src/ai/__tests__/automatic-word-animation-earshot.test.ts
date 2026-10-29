import { beforeEach, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
const compile = mock(() => ({
	valid: true,
	sourceJson: "word-source",
	wordCount: 1,
	coveragePercent: 4,
	summary: "Word accent",
}));
let rejectSound = false;
const planSounds = mock(
	async (input: { sourceJson: string; wordReveals: boolean }) => {
		expect(input.sourceJson).toBe("word-source");
		expect(input.wordReveals).toBe(true);
		if (rejectSound) throw new Error("Sound preflight rejected");
		return {
			valid: true,
			sourceJson: "words-and-sounds",
			soundCount: 1,
			summary: "One matched Earshot accent",
		};
	},
);
mock.module("opencut-wasm", () => ({ compileAutomaticWordAnimation: compile }));
mock.module("@/ai/client-transport", () => ({
	aiClientFetch: async () =>
		Response.json({
			response: { output_text: '{"summary":"Test","events":[]}' },
		}),
}));
mock.module("@/ai/automatic-sound-effects", () => ({
	planAutomaticSoundEffects: planSounds,
}));
mock.module("@/text/caption-presets", () => ({
	CAPTION_WORD_ANIMATIONS: [{ id: "pop" }],
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: () => ({
		valid: true,
		formattedText: "original",
		baseRevision: "r1",
	}),
	parseTimelineDocumentV2: ({ text }: { text: string }) => {
		expect(text).toBe("words-and-sounds");
		return { valid: true, value: { tracks: {}, bookmarks: [] } };
	},
}));
mock.module("@/timeline/scenes", () => ({ updateSceneInArray: () => [] }));
mock.module("@/wasm", () => ({
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
}));
const { runAutomaticWordAnimation } =
	await import("../automatic-word-animation");
const apply = mock(({ execute }: { execute: () => void }) => execute());
const setScenes = mock(() => {});
const scene = {
	id: "scene",
	tracks: {
		overlay: [
			{
				type: "text",
				captionSource: {
					words: [{ text: "fact", startTime: 0, endTime: 120000 }],
				},
			},
		],
	},
};
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Partial fixture for the platform orchestration boundary, not a second document implementation.
const editor = {
	project: { getActive: () => ({ metadata: { id: "project" } }) },
	scenes: { getActiveScene: () => scene, getScenes: () => [scene], setScenes },
	timeline: { getTotalDuration: () => 120000 },
	renderer: { capturePreviewFrameAt: async () => ({ success: false }) },
	command: { executeTransaction: apply },
	save: { markDirty: () => {} },
} as unknown as EditorCore;
beforeEach(() => {
	rejectSound = false;
	compile.mockClear();
	planSounds.mockClear();
	apply.mockClear();
	setScenes.mockClear();
});
test("standalone word animation includes creative reveal and code sounds in one canonical edit", async () => {
	const result = await runAutomaticWordAnimation({
		editor,
		signal: new AbortController().signal,
		onProgress: () => {},
	});
	expect(compile).toHaveBeenCalledWith(
		expect.objectContaining({ proceduralSounds: true, creativeReveals: true }),
	);
	expect(planSounds).toHaveBeenCalledTimes(1);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(result.soundCount).toBe(1);
});
test("failed sound preflight never publishes only the word-animation half", async () => {
	rejectSound = true;
	await expect(
		runAutomaticWordAnimation({
			editor,
			signal: new AbortController().signal,
			onProgress: () => {},
		}),
	).rejects.toThrow("Sound preflight rejected");
	expect(apply).not.toHaveBeenCalled();
	expect(setScenes).not.toHaveBeenCalled();
});
