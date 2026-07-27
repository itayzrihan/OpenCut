import { describe, expect, test } from "bun:test";
import { shouldUseWaveformWorker } from "@/services/waveform-cache/service";

describe("waveform cache", () => {
	test("uses worker only when available and the source is large enough", () => {
		expect(
			shouldUseWaveformWorker({
				totalSamples: 1_000_000,
				channelCount: 1,
				isWorkerAvailable: true,
			}),
		).toBe(true);
		expect(
			shouldUseWaveformWorker({
				totalSamples: 499_999,
				channelCount: 2,
				isWorkerAvailable: true,
			}),
		).toBe(false);
		expect(
			shouldUseWaveformWorker({
				totalSamples: 1_000_000,
				channelCount: 2,
				isWorkerAvailable: false,
			}),
		).toBe(false);
	});
});
