// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import {
	estimatePodcastPrecision,
	planPodcastPrecision,
	resolvePodcastPrecision,
} from "opencut-wasm";
import { readEnergyEnvelope } from "./energy-reader";

test("decoded bounded PCM and real WASM retain subframe offset including polarity", async () => {
	const frames = 48000 * 10,
		bytes = new ArrayBuffer(44 + frames * 2),
		v = new DataView(bytes);
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
	};
	text(0, "RIFF");
	v.setUint32(4, 36 + frames * 2, true);
	text(8, "WAVEfmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true);
	v.setUint16(22, 1, true);
	v.setUint32(24, 48000, true);
	v.setUint32(28, 96000, true);
	v.setUint16(32, 2, true);
	v.setUint16(34, 16, true);
	text(36, "data");
	v.setUint32(40, frames * 2, true);
	let x = 7123;
	for (let i = 0; i < frames; i++) {
		if (i % 3 === 0) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
		}
		v.setInt16(44 + i * 2, x % 16000, true);
	}
	const asset = {
		name: "pcm.wav",
		file: new Blob([bytes], { type: "audio/wav" }),
	};
	const read = (startSeconds: number) =>
		readEnergyEnvelope({
			asset,
			windowSeconds: 1 / 16000,
			startSeconds,
			durationSeconds: 8,
			sampleMode: "waveform",
		});
	const [a, b] = await Promise.all([read(0.6), read(0.7733125)]);
	const r = estimatePodcastPrecision({
		reference: Array.from(a),
		target: Array.from(b, (v) => -v * 0.2),
		sampleRate: 16000,
	});
	expect(Math.abs(r.offsetSeconds - 0.1733125)).toBeLessThan(0.0002);
	expect(r.confidence).toBeGreaterThan(0.85);
	const alignment = {
		offsets: [0, 10],
		confidence: [1, 0.8],
		referenceIndex: 0,
		parents: [undefined, 0],
	};
	const windows = planPodcastPrecision({ alignment, durations: [100, 100] });
	expect(windows.length).toBe(5);
	const refined = resolvePodcastPrecision({
		alignment,
		windows,
		estimates: windows.map(() => r),
	});
	expect(Math.abs(refined.offsets[1]! - 10.1733125)).toBeLessThan(0.0002);
	expect(refined.unverified.length).toBe(0);
});
