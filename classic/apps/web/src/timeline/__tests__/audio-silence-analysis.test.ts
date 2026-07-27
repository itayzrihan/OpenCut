import { describe, expect, test } from "bun:test";
import {
	AUDIO_BASED_AUDIO_FRAME_SECONDS,
	AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS,
	extractCompactAudioFeatures,
} from "@/timeline/audio-silence-analysis";

describe("compact audio silence features", () => {
	test("keeps the one-click audio mode at a true 0.1-second no-padding cut", () => {
		expect(AUDIO_BASED_AUDIO_FRAME_SECONDS).toBe(0.01);
		expect(AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS.minSilenceSeconds).toBe(0.1);
		expect(AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS.speechPaddingSeconds).toBe(0);
	});

	test("maps trimmed source frames into retimed clip-local time", async () => {
		const sampleRate = 100;
		const samples = new Float32Array(400);
		samples.fill(0.5, 100, 200);

		const frames = await extractCompactAudioFeatures({
			samples,
			sampleRate,
			sourceStartSeconds: 1,
			sourceEndSeconds: 2,
			playbackRate: 2,
			frameDurationSeconds: 0.5,
			yieldEveryFrames: 0,
		});

		expect(frames).toHaveLength(2);
		expect(frames[0]).toMatchObject({ start: 0, end: 0.25, rms: 0.5 });
		expect(frames[1]).toMatchObject({ start: 0.25, end: 0.5, rms: 0.5 });
	});

	test("yields during long feature extraction", async () => {
		let yields = 0;
		await extractCompactAudioFeatures({
			samples: new Float32Array(1_000),
			sampleRate: 100,
			sourceStartSeconds: 0,
			sourceEndSeconds: 10,
			playbackRate: 1,
			frameDurationSeconds: 0.1,
			yieldEveryFrames: 10,
			yieldControl: async () => {
				yields += 1;
			},
		});

		expect(yields).toBeGreaterThan(0);
	});
});
