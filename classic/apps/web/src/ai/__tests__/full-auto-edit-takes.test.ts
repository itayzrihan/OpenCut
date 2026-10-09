/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Host adapters are injected test doubles. */
import { expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
const calls: string[] = [];
let silenceFailure: Error | undefined;
let duringSilence: () => void = () => {};
const silenceCalls: Array<
	Parameters<EditorCore["timeline"]["removeAllSilence"]>[0]
> = [];
let restoredSelections = 0;
let fontAvailable = true;
let duringFont: () => void = () => {};
let customFonts = [{ family: "Assistant Bold" }];
const loadedSources: Array<{ family: string; sourceUrl?: string }> = [];
const main = {
	id: "main",
	elements: [
		{
			id: "late-source",
			type: "video",
			startTime: 0,
			duration: 240000,
			trimStart: 12000000,
		},
		{
			id: "early-source",
			type: "video",
			startTime: 240000,
			duration: 120000,
			trimStart: 1200000,
		},
	],
};
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => [
		"preflight",
		"framing",
		"silence",
		"auto-texts",
		"finish",
		"save",
	],
	compileFullAutoEdit: () => {
		calls.push("finish");
		return { valid: true, sourceJson: "{}" };
	},
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: () => ({ formattedText: "{}" }),
	parseTimelineDocumentV2: () => ({
		valid: true,
		value: {
			tracks: { main, overlay: [], audio: [] },
			bookmarks: [],
			projectSettings: {},
		},
	}),
}));
mock.module("@/timeline/scenes", () => ({ updateSceneInArray: () => [] }));
mock.module("@/ai/subject-framing", () => ({
	runLocalSubjectFraming: async ({ editor }: { editor: EditorCore }) => {
		expect(main).toEqual(editor.scenes.getActiveScene().tracks.main);
		expect(editor.scenes.getActiveScene().takeAssembly).toBeUndefined();
		calls.push("framing");
		return { warnings: [] };
	},
}));
mock.module("@/subtitles/auto-texts", () => ({
	runAutoTexts: async ({ editor }: { editor: EditorCore }) => {
		if (calls.includes("prepare"))
			expect(editor.scenes.getActiveScene().tracks.overlay).toEqual([]);
		calls.push("fresh transcription");
	},
}));
mock.module("@/subtitles/caption-layout", () => ({
	DEFAULT_CAPTION_LAYOUT: {},
}));
mock.module("@/fonts/custom-fonts", () => ({
	loadProjectFont: async ({
		font,
	}: {
		font: { family: string; sourceUrl?: string };
	}) => {
		loadedSources.push(font);
		duringFont();
	},
	isProjectFontLoaded: () => fontAvailable,
}));
mock.module("@/services/transcription/service", () => ({
	assertBrowserTranscriptionAvailable: () => {},
}));
mock.module("@/ai/automatic-zoom", () => ({ runAutomaticZoom: () => {} }));
mock.module("@/ai/automatic-text-transitions", () => ({
	runAutomaticTextTransitions: () => {},
}));
mock.module("@/ai/automatic-word-animation", () => ({
	runAutomaticWordAnimation: () => {},
}));
mock.module("@/ai/automatic-music", () => ({ runAutomaticMusic: () => {} }));
const { runFullAutoEdit } = await import("../full-auto-edit");
function setup() {
	calls.length = 0;
	silenceCalls.length = 0;
	silenceFailure = undefined;
	duringSilence = () => {};
	restoredSelections = 0;
	fontAvailable = true;
	customFonts = [{ family: "Assistant Bold" }];
	loadedSources.length = 0;
	duringFont = () => {};
	let revision = 1;
	const scene = {
		id: "s",
		takeAssembly: {} as object | undefined,
		tracks: {
			main,
			overlay: [{ type: "text", elements: [{ id: "old-caption" }] }],
			audio: [],
		},
	};
	const editor = {
		project: {
			getActive: () => ({
				metadata: { id: "p" },
				customFonts,
			}),
			updateSettings: async () => {},
		},
		scenes: {
			getActiveScene: () => scene,
			getScenes: () => [scene],
			setScenes: () => {},
		},
		command: {
			flushHistory: async () => {},
			getStateRevision: () => revision,
			prepareSmartTakesForAutoEdit: () => {
				calls.push("prepare");
				scene.takeAssembly = undefined;
				scene.tracks.overlay = [];
				revision++;
			},
			executeTransaction: ({ execute }: { execute: () => void }) => execute(),
		},
		timeline: {
			removeAllSilence: async (
				options: Parameters<EditorCore["timeline"]["removeAllSilence"]>[0],
			) => {
				expect(scene.tracks.main).toEqual(main);
				calls.push("silence");
				silenceCalls.push(options);
				duringSilence();
				if (silenceFailure) throw silenceFailure;
			},
		},
		selection: {
			getSnapshot: () => ({}),
			setSelectedElements: () => {},
			restoreSnapshot: () => {
				restoredSelections++;
			},
		},
		save: {
			flush: async () => {
				calls.push("save");
			},
			markDirty: () => {},
		},
	} as unknown as EditorCore;
	return { editor, scene, changeRevision: () => revision++ };
}
const options = {
	zoom: false,
	transitions: false,
	wordAnimation: false,
	music: false,
};
const run = ({
	editor,
	signal = new AbortController().signal,
}: {
	editor: EditorCore;
	signal?: AbortSignal;
}) => runFullAutoEdit({ editor, signal, onProgress: () => {}, options });
test("chosen cuts run through all base stages without exporting or reusing old captions", async () => {
	const { editor } = setup();
	await run({ editor });
	expect(calls).toEqual([
		"prepare",
		"save",
		"save",
		"framing",
		"save",
		"silence",
		"save",
		"fresh transcription",
		"save",
		"finish",
		"save",
		"save",
	]);
});
test("font failure, cancellation and stale preflight leave the assembly intact", async () => {
	for (const failure of ["font", "cancel", "stale"]) {
		const { editor, scene, changeRevision } = setup();
		const controller = new AbortController();
		if (failure === "font") fontAvailable = false;
		if (failure === "cancel") duringFont = () => controller.abort();
		if (failure === "stale") duringFont = changeRevision;
		await expect(run({ editor, signal: controller.signal })).rejects.toThrow();
		expect(calls).toEqual([]);
		expect(scene.takeAssembly).toEqual({});
		expect(scene.tracks.overlay).toHaveLength(1);
	}
});
test("ordinary edited scenes are still rejected before any mutation", async () => {
	const { editor, scene } = setup();
	scene.takeAssembly = undefined;
	await expect(run({ editor })).rejects.toThrow("already contains edits");
	expect(calls).toEqual([]);
});
test("missing custom font loads the included bold face and continues past preflight", async () => {
	const { editor } = setup();
	customFonts = [];
	await run({ editor });
	expect(loadedSources).toEqual([
		{
			family: "Assistant Bold",
			sourceUrl: "/fonts/assistant/Assistant-Bold.ttf",
		},
	]);
	expect(calls).toContain("prepare");
	expect(calls).toContain("fresh transcription");
	expect(calls).toContain("finish");
});
test("bundled font failure and stale context leave selected takes and captions intact", async () => {
	for (const failure of ["font", "cancel", "stale"]) {
		const { editor, scene, changeRevision } = setup();
		customFonts = [];
		const controller = new AbortController();
		if (failure === "font") fontAvailable = false;
		if (failure === "cancel") duringFont = () => controller.abort();
		if (failure === "stale") duringFont = changeRevision;
		await expect(run({ editor, signal: controller.signal })).rejects.toThrow();
		expect(calls).toEqual([]);
		expect(scene.takeAssembly).toEqual({});
		expect(scene.tracks.overlay).toHaveLength(1);
	}
});

for (const checkpoint of [3, 4]) {
	test(`resume at checkpoint ${checkpoint} preserves cuts and skips completed stages`, async () => {
		const { editor, scene } = setup();
		scene.takeAssembly = undefined;
		const before = JSON.stringify(scene.tracks.main);
		await runFullAutoEdit({
			editor,
			options,
			signal: new AbortController().signal,
			onProgress: () => {},
			resumeFromStage: checkpoint,
		});
		expect(calls).not.toContain("prepare");
		expect(calls).not.toContain("framing");
		expect(calls).not.toContain("silence");
		expect(calls.includes("fresh transcription")).toBe(checkpoint === 3);
		expect(calls).toContain("finish");
		expect(loadedSources).toHaveLength(1);
		expect(JSON.stringify(scene.tracks.main)).toBe(before);
	});
}

for (const smartTakes of [true, false]) {
	test(`Full Auto uses smart speech protection for ${smartTakes ? "Smart Takes" : "imported video"}`, async () => {
		const { editor, scene } = setup();
		if (!smartTakes) {
			scene.takeAssembly = undefined;
			scene.tracks.overlay = [];
		}
		const controller = new AbortController();
		await run({ editor, signal: controller.signal });
		expect(silenceCalls).toEqual([
			{ mode: "smart", minSilenceSeconds: 0.3, signal: controller.signal },
		]);
		expect(restoredSelections).toBe(1);
		expect(calls).toContain("finish");
	});
}

test("smart safety hold preserves audio and completes later stages without a legacy fallback", async () => {
	const { editor, scene } = setup();
	const before = JSON.stringify(scene.tracks.main);
	silenceFailure = new Error(
		"No clear pauses met this duration after protecting speech.",
	);
	silenceFailure.name = "NoClearSilence";
	const notes = await run({ editor });
	expect(notes).toContain(`Smart audio cut: ${silenceFailure.message}`);
	expect(silenceCalls).toHaveLength(1);
	expect(silenceCalls[0]?.mode).toBe("smart");
	expect(JSON.stringify(scene.tracks.main)).toBe(before);
	expect(calls).toContain("fresh transcription");
	expect(calls).toContain("finish");
	expect(restoredSelections).toBe(1);
});

for (const failure of ["decode", "cancel", "scene-change"]) {
	test(`smart ${failure} failure stops Full Auto and restores selection`, async () => {
		const { editor, scene } = setup();
		const controller = new AbortController();
		silenceFailure = new Error("Source audio unavailable");
		if (failure !== "decode") {
			silenceFailure.name = "NoClearSilence";
			duringSilence = () => {
				if (failure === "cancel") controller.abort();
				else scene.id = "another-scene";
			};
		}
		await expect(run({ editor, signal: controller.signal })).rejects.toThrow(
			failure === "cancel"
				? "Cancelled"
				: failure === "scene-change"
					? "Project or scene changed"
					: "Source audio unavailable",
		);
		expect(silenceCalls).toHaveLength(1);
		expect(calls).not.toContain("fresh transcription");
		expect(calls).not.toContain("finish");
		expect(restoredSelections).toBe(1);
	});
}
