import { beforeEach, expect, mock, test } from "bun:test";
import { wasm } from "../../../test-support/wasm";
import type { EditorCore } from "@/core";
import type { AnalyzeSmartAudioSilenceOptions } from "opencut-wasm";
import type { TranscriptionWord } from "@/transcription/types";
import { mediaTime } from "@/wasm";

type DecodeOptions = Parameters<
	typeof import("@/media/audio").decodeAudioToFloat32
>[0];
type CutOptions = Parameters<
	typeof import("../cut-silence").removeSilenceRangesFromTracks
>[0];
type SelectedClip = {
	track: { id: string; type: string };
	element: {
		id: string;
		type: string;
		mediaId: string;
		startTime: number;
		trimStart: number;
		duration: number;
		trimEnd: number;
		params: Record<string, number>;
		retime?: { rate: number };
	};
};
type TestScene = {
	id: string;
	tracks: {
		main: { id: string; type: string; elements: SelectedClip["element"][] };
		audio: Array<{
			id: string;
			type: string;
			elements: SelectedClip["element"][];
		}>;
		overlay: Array<{
			id: string;
			type: string;
			elements: SelectedClip["element"][];
			locked?: boolean;
			captionSource: { words: TranscriptionWord[] };
		}>;
	};
};
let analysis: AnalyzeSmartAudioSilenceOptions[] = [];
let decodeOptions: DecodeOptions[] = [];
let onDecode: () => void = () => {};
let committed: unknown[] = [];
let applied: CutOptions[] = [];
let selection: SelectedClip[];
let scene: TestScene;
let project: {
	metadata: { id: string };
	settings: { canvasSize: { width: number; height: number } };
};
let revision: number;
let samples: Float32Array;
let useRealAnalyzer = false;
let plan: (tracks: CutOptions["tracks"]) => CutOptions["tracks"];
mock.module("opencut-wasm", () => ({
	...wasm,
	analyzeSmartAudioSilence: (options: AnalyzeSmartAudioSilenceOptions) => {
		analysis.push(options);
		if (useRealAnalyzer) return wasm.analyzeSmartAudioSilence(options);
		return { cutRanges: [{ start: 0.4, end: 0.6 }], diagnostics: {} };
	},
}));
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 120000,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * 120000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120000,
}));
mock.module("@/media/audio", () => ({
	decodeAudioToFloat32: async (options: DecodeOptions) => {
		decodeOptions.push(options);
		onDecode();
		return { samples, sampleRate: 1000 };
	},
}));
mock.module("@/media/unified-angles", () => ({
	resolveUnifiedAnglesAudioAsset: ({ asset }: { asset: unknown }) => asset,
}));
mock.module("@/timeline/audio-separation", () => ({
	doesElementHaveEnabledAudio: () => true,
}));
mock.module("@/timeline/audio-state", () => ({ isElementMuted: () => false }));
mock.module("@/commands/timeline/tracks-snapshot", () => ({
	TracksSnapshotCommand: class {
		constructor(public options: unknown) {}
	},
}));
mock.module("@/timeline/cut-silence", () => ({
	removeSilenceRangesFromTracks: (options: CutOptions) => {
		applied.push(options);
		return plan(options.tracks);
	},
}));
const { removeSmartSilence } = await import("../smart-silence");
const editor = {
	command: {
		enableCanonical: async () => {},
		getStateRevision: () => revision,
		executeSilenceTransaction: (options: {
			operation: string;
			execute: () => void;
		}) => {
			committed.push(options.operation);
			options.execute();
		},
		execute: (options: unknown) => committed.push(options),
	},
	project: { getActive: () => project, getActiveOrNull: () => project },
	scenes: { getActiveScene: () => scene, getActiveSceneOrNull: () => scene },
	timeline: { getElementsWithTracks: () => selection },
	selection: { getSelectedElements: () => [] },
	media: { getAssets: () => [{ id: "media", url: "blob:source" }] },
} as unknown as EditorCore;
beforeEach(() => {
	analysis = [];
	decodeOptions = [];
	committed = [];
	applied = [];
	onDecode = () => {};
	revision = 0;
	samples = new Float32Array(3000);
	useRealAnalyzer = false;
	plan = (tracks) => ({ ...tracks });
	project = {
		metadata: { id: "project" },
		settings: { canvasSize: { width: 1920, height: 1080 } },
	};
	scene = {
		id: "scene",
		tracks: {
			main: { id: "track", type: "video", elements: [] },
			audio: [],
			overlay: [
				{
					id: "captions-one",
					type: "text",
					elements: [],
					captionSource: {
						words: [{ start: 0.8, end: 1.2, text: "crossing" }],
					},
				},
				{
					id: "captions-two",
					type: "text",
					elements: [],
					captionSource: {
						words: [
							{
								start: 1.3,
								end: 1.5,
								text: "edited",
								source: {
									type: "text-layer",
									trackId: "caption",
									elementId: "word",
									wordIndex: 0,
								},
							},
						],
					},
				},
			],
		},
	};
	selection = [
		{
			track: { id: "track", type: "video" },
			element: {
				id: "clip",
				type: "video",
				mediaId: "media",
				startTime: 120000,
				trimStart: 120000,
				duration: 120000,
				trimEnd: 120000,
				params: {},
			},
		},
	];
	scene.tracks.main.elements = [selection[0].element];
});
test("protects crossing words and edited words from every source; uses separate settings and canonical undo", async () => {
	await removeSmartSilence({ editor, minSilenceSeconds: 0.8 });
	expect(analysis[0].settings?.minSilenceSeconds).toBe(0.8);
	expect(analysis[0].transcriptWords).toHaveLength(2);
	expect(analysis[0].transcriptWords?.[0].start).toBe(0);
	expect(analysis[0].transcriptWords?.[0].end).toBeCloseTo(0.2);
	expect(decodeOptions[0].channelMix).toBe("max-magnitude");
	expect(committed[0]).toBe("smart-remove");
	expect(committed[1]).toMatchObject({ applyRipple: false });
	expect(applied[0].ranges).toMatchObject([
		{ startTime: 168000, endTime: 192000 },
	]);
});

test("analyzes the audible source after a sync advance using the playback timing contract", async () => {
	selection[0].element.params.audioSyncOffset = -0.3;
	samples.fill(0.8, 1300);
	await removeSmartSilence({ editor });
	expect(analysis[0].frames[0].rms).toBeCloseTo(0.8);
	expect(analysis[0].durationSeconds).toBe(1);
	expect(applied[0].ranges).toMatchObject([
		{ startTime: 168000, endTime: 192000 },
	]);
});

test("sync delay keeps missing source intact and maps cuts and words from audible start", async () => {
	selection[0].element.trimStart = 12000;
	selection[0].element.params.audioSyncOffset = 0.3;
	await removeSmartSilence({ editor });
	expect(analysis[0].durationSeconds).toBeCloseTo(0.8);
	expect(analysis[0].frames[0].start).toBe(0);
	expect(analysis[0].transcriptWords).toHaveLength(1);
	expect(analysis[0].transcriptWords?.[0].start).toBeCloseTo(0.1);
	expect(analysis[0].transcriptWords?.[0].end).toBeCloseTo(0.3);
	expect(applied[0].ranges).toMatchObject([
		{ startTime: 192000, endTime: 216000 },
	]);
});

test("missing decoded timestamp regions reach Rust as invalid coverage rather than silence", async () => {
	useRealAnalyzer = true;
	samples.fill(0.1);
	samples.fill(Number.NaN, 1400, 1410);
	await expect(removeSmartSilence({ editor })).rejects.toThrow("No cuts applied");
	const actual = wasm.analyzeSmartAudioSilence(analysis[0]);
	expect(actual.diagnostics.safetyHoldReason).toBe("invalid-audio-features");
	expect(actual.cutRanges).toHaveLength(0);
	expect(committed).toHaveLength(0);
});

test("refuses companion audio tail loss before publishing the prepared edit", async () => {
	scene.tracks.audio.push({
		id: "speech",
		type: "audio",
		elements: [
			{ ...selection[0].element, id: "separate-voice", type: "audio" },
		],
	});
	plan = (tracks) => ({
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => ({
				...element,
				duration: mediaTime({ ticks: element.duration - 12000 }),
				trimEnd: mediaTime({ ticks: element.trimEnd + 12000 }),
			})),
		})),
	});
	await expect(removeSmartSilence({ editor })).rejects.toThrow(
		"shorten another audible clip",
	);
	expect(committed).toHaveLength(0);
});

test("refuses changed locked captions while allowing untouched locked tracks", async () => {
	scene.tracks.overlay[0].locked = true;
	await removeSmartSilence({ editor });
	expect(committed).not.toHaveLength(0);
	committed = [];
	plan = (tracks) => ({
		...tracks,
		overlay: tracks.overlay.filter((track) => track.id !== "captions-one"),
	});
	await expect(removeSmartSilence({ editor })).rejects.toThrow("locked track");
	expect(committed).toHaveLength(0);
});
test("does not overwrite an edit that happens during decoding", async () => {
	onDecode = () => {
		revision += 1;
	};
	await expect(removeSmartSilence({ editor })).rejects.toThrow(
		"timeline changed",
	);
	expect(committed).toHaveLength(0);
});
test("cancellation before commit leaves project intact", async () => {
	const controller = new AbortController();
	onDecode = () => controller.abort();
	await expect(
		removeSmartSilence({ editor, signal: controller.signal }),
	).rejects.toThrow();
	expect(committed).toHaveLength(0);
});
test("overlapping clips cannot delete another selected speaker's words", async () => {
	selection.push({
		...selection[0],
		element: { ...selection[0].element, id: "clip2" },
	});
	await expect(removeSmartSilence({ editor })).rejects.toThrow(
		"non-overlapping",
	);
	expect(decodeOptions).toHaveLength(0);
});
