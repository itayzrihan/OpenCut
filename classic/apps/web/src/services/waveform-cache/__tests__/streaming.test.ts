import { expect, test } from "bun:test";
import { buildStreamingSourceWaveformSummary } from "../streaming";

test("worker-compatible streaming matches known PCM peaks and the original AudioBuffer path", async () => {
	const rate = 48000,
		frames = 4800,
		channels = 2;
	const bytes = new ArrayBuffer(44 + frames * channels * 4),
		view = new DataView(bytes);
	const word = ({ offset, value }: { offset: number; value: string }) =>
		[...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
	word({ offset: 0, value: "RIFF" });
	view.setUint32(4, bytes.byteLength - 8, true);
	word({ offset: 8, value: "WAVE" });
	word({ offset: 12, value: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 3, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * channels * 4, true);
	view.setUint16(32, channels * 4, true);
	view.setUint16(34, 32, true);
	word({ offset: 36, value: "data" });
	view.setUint32(40, frames * channels * 4, true);
	for (let i = 0; i < frames; i++) {
		view.setFloat32(44 + i * 8, i % 480 === 479 ? -0.75 : 0.125, true);
		view.setFloat32(48 + i * 8, 0.5, true);
	}
	const sourceFile = new File([bytes], "peaks.wav", { type: "audio/wav" });
	const summary = await buildStreamingSourceWaveformSummary({
		sourceKey: "fixture",
		sourceFile,
	});
	expect(summary.sampleRate).toBe(rate);
	expect(summary.totalSamples).toBe(frames);
	expect(summary.bucketSize).toBe(480);
	expect([...summary.amplitudes]).toEqual(Array(10).fill(0.75));
	const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer");
	class BufferForTest {
		length: number;
		numberOfChannels: number;
		sampleRate: number;
		data: Float32Array[];
		constructor(args: {
			length: number;
			numberOfChannels: number;
			sampleRate: number;
		}) {
			Object.assign(this, args);
			this.length = args.length;
			this.numberOfChannels = args.numberOfChannels;
			this.sampleRate = args.sampleRate;
			this.data = Array.from(
				{ length: args.numberOfChannels },
				() => new Float32Array(args.length),
			);
		}
		getChannelData(channel: number) {
			return this.data[channel];
		}
		// Web Audio API compatibility requires positional arguments.
		// eslint-disable-next-line opencut/prefer-object-params
		copyToChannel(source: Float32Array, channel: number) {
			this.data[channel].set(source);
		}
	}
	Object.defineProperty(globalThis, "AudioBuffer", {
		configurable: true,
		value: BufferForTest,
	});
	try {
		expect(
			await buildStreamingSourceWaveformSummary({
				sourceKey: "fixture",
				sourceFile,
				useAudioBuffer: true,
			}),
		).toEqual(summary);
	} finally {
		if (previous) Object.defineProperty(globalThis, "AudioBuffer", previous);
		else Reflect.deleteProperty(globalThis, "AudioBuffer");
	}
	const abort = new AbortController();
	abort.abort();
	await expect(
		buildStreamingSourceWaveformSummary({
			sourceKey: "cancelled",
			sourceFile,
			signal: abort.signal,
		}),
	).rejects.toThrow();
});
