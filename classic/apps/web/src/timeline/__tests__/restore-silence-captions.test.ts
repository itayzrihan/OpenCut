import { describe, expect, mock, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
mock.module("@/media/audio", () => ({
	resolveAudioBufferForAsset: () => {
		throw new Error("Inject decoder");
	},
}));
mock.module("@/services/transcription/service", () => ({
	transcriptionService: {
		transcribe: () => {
			throw new Error("Inject transcription");
		},
	},
}));
mock.module("opencut-wasm", () => ({
	restoreSilenceCaptions: () => {
		throw new Error("Inject compiler");
	},
}));
mock.module("@/ai/timeline-document-v2", () => ({
	buildTimelineDocumentV2: ({ scene }: { scene: { revision: string } }) => ({
		valid: true,
		baseRevision: scene.revision,
		formattedText: "source",
	}),
	parseTimelineDocumentV2: () => ({
		valid: true,
		value: { tracks: { overlay: [] }, bookmarks: [] },
	}),
}));
mock.module("@/timeline/scenes", () => ({
	updateSceneInArray: ({ scenes }: { scenes: unknown }) => scenes,
}));
mock.module("@/utils/id", () => ({ generateUUID: () => "injected-id" }));
import type { RestoreCaptionDependencies } from "../restore-silence-captions";
const { fillRestoredSilenceCaptions } =
	await import("../restore-silence-captions");
import type { SilenceRestoration } from "../restore-silence";

function fixture() {
	const scene = { id: "scene", revision: "restored", tracks: { overlay: [] } };
	const project = { metadata: { id: "project" } };
	const commits: string[] = [];
	let writes = 0;
	const editor = {
		project: { getActive: () => project },
		scenes: {
			getActiveScene: () => scene,
			getScenes: () => [scene],
			setScenes: () => {
				writes++;
			},
		},
		media: { getAssets: () => [{ id: "media", type: "video" } as MediaAsset] },
		transcription: { getState: () => ({ language: "he" }) },
		command: {
			enableCanonical: async () => {},
			executeSilenceTransaction: ({
				operation,
				execute,
			}: {
				operation: string;
				execute: () => void;
			}) => {
				commits.push(operation);
				execute();
			},
		},
		save: { markDirty: () => {} },
	} as unknown as EditorCore;
	const restoration = {
		projectId: "project",
		sceneId: "scene",
		restoredRevision: "restored",
		restoredIntervals: [
			{
				trackId: "video",
				elementId: "clip",
				mediaId: "media",
				startTime: 120000,
				endTime: 240000,
				sourceStart: 240000,
				sourceEnd: 360000,
				playbackRate: 1,
			},
		],
	} as SilenceRestoration;
	const controller = new AbortController();
	const positive = new Float32Array(80000).fill(0.2);
	const negative = new Float32Array(80000).fill(-0.2);
	const buffer = {
		sampleRate: 16000,
		length: 80000,
		duration: 5,
		numberOfChannels: 2,
		getChannelData: (channel: number) => (channel ? negative : positive),
	} as AudioBuffer;
	let compilerInput:
		| Parameters<RestoreCaptionDependencies["compile"]>[0]
		| undefined;
	let transcribed: Float32Array | undefined;
	const adapters: RestoreCaptionDependencies = {
		decode: async () => buffer,
		transcribe: async ({ audioData, language }) => {
			expect(language).toBe("he");
			transcribed = audioData;
			return {
				text: "missing",
				language: "he",
				segments: [],
				words: [{ text: "missing", start: 1.1, end: 1.4 }],
			};
		},
		compile: (input) => {
			compilerInput = input;
			return {
				valid: true,
				sourceJson: "compiled",
				error: "",
				insertedWordCount: 1,
				insertedCaptionCount: 1,
			};
		},
		id: () => "request",
	};
	return {
		editor,
		restoration,
		controller,
		adapters,
		scene,
		project,
		commits,
		buffer,
		run: () =>
			fillRestoredSilenceCaptions({
				editor,
				restoration,
				signal: controller.signal,
				adapters,
			}),
		get writes() {
			return writes;
		},
		get compilerInput() {
			return compilerInput;
		},
		get transcribed() {
			return transcribed;
		},
	};
}

describe("restored-gap caption adapter", () => {
	test("uses local contextual source audio without stereo cancellation and commits one guarded transaction", async () => {
		const f = fixture();
		await f.run();
		expect(f.transcribed?.length).toBe(48000);
		expect(f.transcribed?.[0]).toBeCloseTo(0.2);
		expect(JSON.parse(f.compilerInput!.transcriptsJson)).toEqual([
			{ intervalIndex: 0, words: [{ text: "missing", start: 2.1, end: 2.4 }] },
		]);
		expect(f.commits).toEqual(["repair-captions"]);
		expect(f.writes).toBe(1);
	});
	test.each(["project", "scene", "revision"])(
		"rejects stale %s after transcription without modifying the edit",
		async (kind) => {
			const f = fixture();
			const transcribe = f.adapters.transcribe;
			f.adapters.transcribe = async (options) => {
				const result = await transcribe(options);
				if (kind === "project") f.project.metadata.id = "different";
				else if (kind === "scene") f.scene.id = "different";
				else f.scene.revision = "edited";
				return result;
			};
			await expect(f.run()).rejects.toThrow("הטיימליין השתנה");
			expect(f.commits).toEqual([]);
			expect(f.compilerInput).toBeUndefined();
		},
	);
	test("declining work after a later edit rejects before decoding", async () => {
		const f = fixture();
		f.scene.revision = "edited";
		f.adapters.decode = async () => {
			throw new Error("Decoder must not run");
		};
		await expect(f.run()).rejects.toThrow("הטיימליין השתנה");
	});
	test("cancellation remains effective if transcription returns after abort", async () => {
		const f = fixture();
		const transcribe = f.adapters.transcribe;
		f.adapters.transcribe = async (options) => {
			const result = await transcribe(options);
			f.controller.abort();
			return result;
		};
		await expect(f.run()).rejects.toThrow();
		expect(f.commits).toEqual([]);
	});
	test("rejects partially unavailable source audio instead of silently filling only part", async () => {
		const f = fixture();
		f.adapters.decode = async () => ({ ...f.buffer, duration: 2.5 });
		await expect(f.run()).rejects.toThrow("כל טווח");
		expect(f.transcribed).toBeUndefined();
		expect(f.commits).toEqual([]);
	});
	test("empty speech does not create undo history, and untimed speech is rejected", async () => {
		const f = fixture();
		f.adapters.compile = () => ({
			valid: true,
			sourceJson: "source",
			error: "",
			insertedWordCount: 0,
			insertedCaptionCount: 0,
		});
		await f.run();
		expect(f.commits).toEqual([]);
		f.adapters.transcribe = async () => ({
			text: "untimed",
			language: "he",
			segments: [],
		});
		await expect(f.run()).rejects.toThrow("ללא זמני מילים");
	});
	test("checks revision again inside the final canonical transaction", async () => {
		const f = fixture();
		f.editor.command.executeSilenceTransaction = (({
			execute,
		}: {
			execute: () => void;
		}) => {
			f.scene.revision = "changed";
			execute();
		}) as typeof f.editor.command.executeSilenceTransaction;
		await expect(f.run()).rejects.toThrow("הטיימליין השתנה");
		expect(f.writes).toBe(0);
	});
});
