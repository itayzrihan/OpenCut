import { describe, expect, test } from "bun:test";
import { layoutTimedAudioChunks } from "../audio-chunk-layout";

describe("layoutTimedAudioChunks", () => {
	test("preserves timestamp gaps instead of concatenating samples", () => {
		const layout = layoutTimedAudioChunks({
			sampleRate: 100,
			minimumDurationSeconds: 4,
			chunks: [
				{ timestampSeconds: 0, durationSeconds: 1, sampleLength: 100 },
				{ timestampSeconds: 2.5, durationSeconds: 1, sampleLength: 100 },
			],
		});

		expect(layout.totalSamples).toBe(400);
		expect(layout.placements).toEqual([
			{
				chunkIndex: 0,
				sourceStartSample: 0,
				outputStartSample: 0,
				sampleCount: 100,
			},
			{
				chunkIndex: 1,
				sourceStartSample: 0,
				outputStartSample: 250,
				sampleCount: 100,
			},
		]);
	});

	test("clips negative preroll while keeping media time zero aligned", () => {
		const layout = layoutTimedAudioChunks({
			sampleRate: 100,
			chunks: [
				{
					timestampSeconds: -0.25,
					durationSeconds: 1,
					sampleLength: 100,
				},
			],
		});

		expect(layout.totalSamples).toBe(75);
		expect(layout.placements).toEqual([
			{
				chunkIndex: 0,
				sourceStartSample: 25,
				outputStartSample: 0,
				sampleCount: 75,
			},
		]);
	});
});
