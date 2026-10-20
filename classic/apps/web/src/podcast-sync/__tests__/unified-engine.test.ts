// @opencut-test-wasm: real
import { expect, mock, test } from "bun:test";
import { podcastMulticamDefaults, analyzePodcastMulticam } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
import { createUnifiedAnglesAsset } from "@/media/unified-angles";
const readNames: string[] = [];
let externalRecorder = false;
type WorkerRequest =
	| { type: "read"; asset: MediaAsset }
	| { type: "align" }
	| { type: "precision" }
	| {
			type: "route";
			envelopes: Float32Array[];
			channelIds: string[];
			duration: number;
			settings: import("opencut-wasm").PodcastMulticamSettings;
			cameraWindows: import("opencut-wasm").PodcastCameraWindow[];
	  };
mock.module("../sync-jobs", () => ({
	mapConcurrent: async ({
		items,
		task,
	}: {
		items: MediaAsset[];
		task: (a: MediaAsset, s: AbortSignal) => Promise<unknown>;
	}) => Promise.all(items.map((a) => task(a, new AbortController().signal))),
	runSyncWorker: async ({ message }: { message: WorkerRequest }) => {
		if (message.type === "read") {
			readNames.push(message.asset.name);
			return new Float32Array(12001).fill(0.5);
		}
		if (message.type === "align")
			return {
				offsets: externalRecorder ? [50, 20, -100] : [50, 20],
				referenceIndex: 1,
				confidence: externalRecorder ? [1, 1, 1] : [1, 1],
				parents: externalRecorder ? [1, undefined, 1] : [1, undefined],
			};
		if (message.type === "precision")
			return { offsetSeconds: 0, confidence: 1 };
		if (message.type === "route")
			return analyzePodcastMulticam({
				...message,
				envelopes: message.envelopes.map((e: Float32Array) => Array.from(e)),
			});
	},
}));
const {
	resolvePodcastChannelSources,
	runPodcastAlignment,
	runPodcastMulticam,
} = await import("../engine");
test("Unified podcast decodes physical cameras once, keeps the longest clock and persists all sound offsets", async () => {
	const video = ({
		id,
		duration,
	}: {
		id: string;
		duration: number;
	}): MediaAsset => ({
		id,
		name: id,
		type: "video",
		duration,
		hasAudio: true,
		url: `blob:${id}`,
		bindingRevision: 1,
	});
	const short = video({ id: "short", duration: 50 }),
		long = video({ id: "long", duration: 120 });
	const unified: MediaAsset = {
		id: "unified",
		...createUnifiedAnglesAsset({ assets: [short, long] }),
	};
	const channels = resolvePodcastChannelSources({
		channels: [
			{ id: "speaker", name: "Speaker", video: unified, audio: unified },
		],
		mediaAssets: [short, long, unified],
	});
	expect(channels[0].audio.id).toBe("long");
	const settings = podcastMulticamDefaults({ quick: true });
	const alignment = await runPodcastAlignment({ channels, settings });
	expect(readNames.sort()).toEqual(["long", "short"]);
	expect(alignment.duration).toBe(120);
	expect(alignment.precisionWarnings).toEqual([]);
	expect(alignment.videoOffsets.speaker).toBe(0);
	expect(alignment.audioOffsets.speaker).toBe(0);
	expect(alignment.unifiedSync[0].sources.map((s) => [s.id, s.start])).toEqual([
		["short", 50],
		["long", 20],
	]);
	const result = await runPodcastMulticam({ channels, settings, alignment });
	expect(result.duration).toBe(120);
	expect(result.cuts.reduce((n, c) => n + c.duration, 0)).toBe(120);
});
test("automatic reaction shots never choose a camera before it starts or after it stops", () => {
	const cuts = analyzePodcastMulticam({
		envelopes: [Array(12000).fill(0.3), Array(12000).fill(0.7)],
		channelIds: ["long", "short"],
		duration: 120,
		settings: podcastMulticamDefaults({ quick: true }),
		cameraWindows: [
			{ channelId: "long", start: 0, end: 120 },
			{ channelId: "short", start: 30, end: 80 },
		],
	});
	expect(cuts.length).toBeGreaterThan(1);
	expect(cuts.reduce((n, c) => n + c.duration, 0)).toBe(120);
	expect(cuts[0].channelId).toBe("long");
	expect(cuts.at(-1)?.channelId).toBe("long");
	for (const cut of cuts.filter((c) => c.channelId === "short")) {
		expect(cut.timestamp).toBeGreaterThanOrEqual(30);
		expect(cut.timestamp + cut.duration).toBeLessThanOrEqual(80);
	}
});

test("Unified with Audio aligns all cameras plus the recorder without replacing it with camera sound", async () => {
	externalRecorder = true;
	readNames.length = 0;
	try {
		const camera = (id: string, duration: number): MediaAsset => ({
			id,
			name: id,
			type: "video",
			duration,
			hasAudio: true,
			bindingRevision: 1,
			url: `blob:${id}`,
		});
		const short = camera("short", 50),
			long = camera("long", 120);
		const recorder: MediaAsset = {
			id: "recorder",
			name: "Recorder",
			type: "audio",
			duration: 7200,
			hasAudio: true,
			bindingRevision: 2,
			url: "blob:recorder",
		};
		const unified: MediaAsset = {
			id: "with-audio",
			...createUnifiedAnglesAsset({ assets: [short, long] }),
		};
		unified.unifiedAngles!.audioAssetId = recorder.id;
		unified.unifiedAngles!.audioFinishingVersion = 1;
		const channels = resolvePodcastChannelSources({
			channels: [
				{
					id: "speaker",
					name: "Teleprompter",
					video: unified,
					audio: recorder,
				},
			],
			mediaAssets: [short, long, recorder, unified],
		});
		expect(channels[0].audio.id).toBe("recorder");
		const aligned = await runPodcastAlignment({
			channels,
			settings: podcastMulticamDefaults({ quick: true }),
		});
		expect(readNames).toEqual(["short", "long", "Recorder"]);
		expect(aligned.duration).toBe(120);
		expect(aligned.unifiedSync[0].sources.map((s) => s.id)).toEqual([
			"short",
			"long",
			"recorder",
		]);
		expect(
			aligned.unifiedSync[0].sources.find((s) => s.id === "recorder")
				?.bindingRevision,
		).toBe(2);
		expect(aligned.audioOffsets.speaker).toBe(120);
	} finally {
		externalRecorder = false;
	}
});
