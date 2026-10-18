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
	getClipAudioTiming: () => ({ startTime: 4, trimStart: 100, duration: 61 }),
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
