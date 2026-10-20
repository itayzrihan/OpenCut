/* eslint-disable @typescript-eslint/no-explicit-any, opencut/prefer-object-params -- Host decoder doubles. */
import { expect, mock, test } from "bun:test";
let closed = 0;
let interrupt: (() => void) | undefined;
const ranges: Array<{ start: number; end: number; missing: string }> = [];
mock.module("@/media/audio-window", () => ({
	SPEECH_SAMPLE_RATE: 16000,
	openAudioWindowReader: async () => ({
		close: () => closed++,
		read: async (r: any) => {
			ranges.push(r);
			if (ranges.length === 2) interrupt?.();
			const s = new Float32Array(Math.ceil((r.end - r.start) * 16000)).fill(
				0.1,
			);
			if (ranges.length === 1) s.fill(NaN, 0, 160);
			return s;
		},
	}),
}));
mock.module("@/media/audio-sync", () => ({
	getClipAudioTiming: (clip: any) =>
		clip.id.startsWith("podcast-audio:")
			? {
					startTime: clip.startTime / 120000,
					trimStart: clip.trimStart / 120000,
					duration: clip.duration / 120000,
				}
			: { startTime: 4, trimStart: 100, duration: 61 },
}));
mock.module("@/media/unified-angles", () => ({
	resolveUnifiedAnglesAudioAsset: ({ asset }: any) => asset,
}));
const { collectTakeAudioEvidence } = await import("./audio-evidence");
test("audio evidence reads bounded source windows, preserves offsets and omits missing coverage", async () => {
	const result = await collectTakeAudioEvidence({
		editor: {
			scenes: {
				getActiveScene: () => ({
					tracks: {
						main: {
							elements: [
								{
									id: "clip",
									type: "video",
									mediaId: "media",
									startTime: 3 * 120000,
									duration: 61 * 120000,
								},
							],
						},
					},
				}),
			},
			media: { getAssets: () => [{ id: "media", url: "http://local/source" }] },
		} as any,
		elementIds: ["clip"],
		signal: new AbortController().signal,
		boundedFrames: true,
	});
	expect(ranges.map((r) => [r.start, r.end])).toEqual([
		[100, 130],
		[130, 160],
		[160, 161],
	]);
	expect(ranges.every((r) => r.missing === "unknown")).toBe(true);
	expect(closed).toBe(3);
	expect(result[0].frames[0].start).toBeCloseTo(1.01, 4);
	expect(result[0].frames.at(-1)!.end).toBeCloseTo(62, 4);
	expect(result[0].frames.every((f) => Number.isFinite(f.rms))).toBe(true);
});

test("completed audio windows survive interruption and a new cache instance without decoding them again", async () => {
	const { IDBFactory } = await import("fake-indexeddb");
	const { IndexedAudioCheckpoints } = await import("./audio-checkpoints");
	const factory = new IDBFactory();
	const editor = {
		scenes: {
			getActiveScene: () => ({
				tracks: {
					main: {
						elements: [
							{
								id: "clip",
								type: "video",
								mediaId: "media",
								startTime: 3 * 120000,
								duration: 61 * 120000,
							},
						],
					},
				},
			}),
		},
		media: {
			getAssets: () => [
				{
					id: "media",
					url: "http://local/source",
					size: 100,
					lastModified: 1,
					bindingRevision: 1,
				},
			],
		},
	} as any;
	ranges.length = 0;
	closed = 0;
	const controller = new AbortController();
	interrupt = () => controller.abort();
	await expect(
		collectTakeAudioEvidence({
			editor,
			elementIds: ["clip"],
			signal: controller.signal,
			boundedFrames: true,
			checkpoint: {
				key: "exact-source",
				store: new IndexedAudioCheckpoints({ factory, databaseName: "resume" }),
			},
		}),
	).rejects.toThrow();
	interrupt = undefined;
	expect(ranges.map((r) => r.start)).toEqual([100, 130]);
	const result = await collectTakeAudioEvidence({
		editor,
		elementIds: ["clip"],
		signal: new AbortController().signal,
		boundedFrames: true,
		checkpoint: {
			key: "exact-source",
			store: new IndexedAudioCheckpoints({ factory, databaseName: "resume" }),
		},
	});
	expect(ranges.map((r) => r.start)).toEqual([100, 130, 130, 160]);
	expect(result[0].frames[0].start).toBeCloseTo(1.01, 4);
	expect(result[0].frames.at(-1)!.end).toBeCloseTo(62, 4);
	const resumed = result[0].frames;
	ranges.length = 0;
	const fresh = await collectTakeAudioEvidence({
		editor,
		elementIds: ["clip"],
		signal: new AbortController().signal,
		boundedFrames: true,
	});
	expect(resumed).toEqual(fresh[0].frames);
});

test("canonical audio inputs decode only selected multicam audio even when the main lane is empty", async () => {
	ranges.length = 0;
	closed = 0;
	interrupt = undefined;
	const result = await collectTakeAudioEvidence({
		editor: {
			scenes: {
				getActiveScene: () => ({ tracks: { main: { elements: [] } } }),
			},
			media: { getAssets: () => [{ id: "voice", url: "http://local/source" }] },
		} as any,
		elementIds: ["podcast-audio:0:2:0"],
		sourceClips: [
			{
				id: "podcast-audio:0:2:0",
				type: "audio",
				mediaId: "voice",
				startTime: 20 * 120000,
				duration: 2 * 120000,
				trimStart: 50 * 120000,
				trimEnd: 0,
				params: { audioSyncOffset: 0 },
			},
		] as any,
		signal: new AbortController().signal,
		boundedFrames: true,
	});
	expect(ranges.map((r) => [r.start, r.end])).toEqual([[50, 52]]);
	expect(result).toHaveLength(1);
	expect(result[0].clipId).toBe("podcast-audio:0:2:0");
	expect(result[0].frames.at(-1)!.end).toBeCloseTo(2, 4);
	expect(closed).toBe(1);
});

test("rounded cached PCM tails never overlap the next decode window", async () => {
	ranges.length = 0;
	interrupt = undefined;
	const clips = [0, 1].flatMap((mic) =>
		[0, 1].map((part) => ({
			id: `podcast-audio:0:${6 + mic}:${part}`,
			type: "audio",
			mediaId: "voice",
			startTime: part ? 1564000 : 0,
			duration: part ? 203932000 : 1564000,
			trimStart: part ? 9704049 : 7616049,
			trimEnd: 0,
			retime: { rate: 1 },
			params: { audioSyncOffset: 0 },
		})),
	);
	const result = await collectTakeAudioEvidence({
		editor: {
			scenes: {
				getActiveScene: () => ({ tracks: { main: { elements: [] } } }),
			},
			media: { getAssets: () => [{ id: "voice", url: "http://local/source" }] },
		} as any,
		elementIds: clips.map((c) => c.id),
		sourceClips: clips as any,
		signal: new AbortController().signal,
		boundedFrames: true,
		checkpoint: {
			key: "fractional-source-clock",
			store: {
				read: async ({ duration }: any) => {
					const samples = Math.round(duration * 16000);
					// Same 161-sample bins and rounded PCM tail as the real decoder.
					return Array.from({ length: Math.ceil(samples / 161) }, (_, i) => ({
						start: (i * 161) / 16000,
						end: Math.min(samples, (i + 1) * 161) / 16000,
						rms: 0.1,
						peak: 0.2,
						zeroCrossingRate: 0,
					}));
				},
				write: async () => {
					throw Error("Cached audio was decoded again");
				},
			},
		},
	});
	expect(ranges).toHaveLength(0);
	expect(result).toHaveLength(4);
	for (let k = 0; k < result.length; k++) {
		const frames = result[k].frames;
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) expect(frame.end).toBeGreaterThan(frame.start);
		for (let i = 1; i < frames.length; i++)
			expect(frames[i].start).toBeGreaterThanOrEqual(frames[i - 1].end - 1e-8);
		expect(frames.at(-1)!.end).toBeLessThanOrEqual(
			clips[k].duration / 120000 + 1e-8,
		);
	}
});
