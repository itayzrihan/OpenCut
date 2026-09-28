import { describe, expect, test } from "bun:test";
import { renderRetimedBuffer } from "../audio-stretch";

function buffer(length: number, sampleRate: number): AudioBuffer {
	const samples = new Float32Array(length);
	return {
		length,
		sampleRate,
		duration: length / sampleRate,
		numberOfChannels: 1,
		getChannelData: () => samples,
	} as unknown as AudioBuffer;
}

describe("sync source handles", () => {
	for (const advance of [0.1, 0.3]) {
		test(`reads the full source past the video cut with ${advance}s advance`, async () => {
			const source = buffer(10000, 1000);
			// Distinct nonzero samples expose truncation, repetition or padding.
			for (let i = 0; i < source.length; i++)
				source.getChannelData(0)[i] = (i + 1) / 10000;
			const context = {
				sampleRate: 1000,
				createBuffer: (_: number, length: number, rate: number) =>
					buffer(length, rate),
			} as unknown as AudioContext;
			for (const duration of [2, 0.08]) {
				const result = await renderRetimedBuffer({
					audioContext: context,
					sourceBuffer: source,
					trimStart: 4 + advance,
					clipDuration: duration,
				});
				expect(result.length).toBe(duration * 1000);
				for (let i = 0; i < result.length; i++) {
					expect(result.getChannelData(0)[i]).toBeCloseTo(
						source.getChannelData(0)[Math.round((4 + advance) * 1000) + i],
						6,
					);
				}
			}
		});
	}
});
