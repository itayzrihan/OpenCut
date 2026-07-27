import { describe, expect, test } from "bun:test";
import {
	buildSourceWaveformSummary,
	buildSourceWaveformSummaryAsync,
} from "@/media/waveform-summary";

class TestAudioBuffer implements AudioBuffer {
	readonly length: number;
	readonly numberOfChannels: number;
	readonly duration: number;
	private readonly channelData: Array<Float32Array<ArrayBuffer>>;
	readonly sampleRate: number;

	constructor({
		channelData,
		sampleRate,
	}: {
		channelData: Array<Float32Array<ArrayBuffer>>;
		sampleRate: number;
	}) {
		this.channelData = channelData;
		this.sampleRate = sampleRate;
		this.length = Math.max(0, ...channelData.map((samples) => samples.length));
		this.numberOfChannels = channelData.length;
		this.duration = sampleRate > 0 ? this.length / sampleRate : 0;
	}

	// eslint-disable-next-line opencut/prefer-object-params -- Implements the browser AudioBuffer interface.
	copyFromChannel(
		destination: Float32Array<ArrayBuffer>,
		channelNumber: number,
		bufferOffset = 0,
	): void {
		destination.set(
			this.getChannelData(channelNumber).subarray(
				bufferOffset,
				bufferOffset + destination.length,
			),
		);
	}

	// eslint-disable-next-line opencut/prefer-object-params -- Implements the browser AudioBuffer interface.
	copyToChannel(
		source: Float32Array<ArrayBuffer>,
		channelNumber: number,
		bufferOffset = 0,
	): void {
		this.getChannelData(channelNumber).set(source, bufferOffset);
	}

	getChannelData(channel: number): Float32Array<ArrayBuffer> {
		return this.channelData[channel] ?? new Float32Array();
	}
}

function createTestAudioBuffer({
	channels,
	sampleRate = 48_000,
}: {
	channels: number[][];
	sampleRate?: number;
}): AudioBuffer {
	const channelData = channels.map((samples) => Float32Array.from(samples));
	return new TestAudioBuffer({ channelData, sampleRate });
}

describe("waveform summary", () => {
	test("async summary matches sync peak buckets", async () => {
		const buffer = createTestAudioBuffer({
			channels: [
				[0, 0.2, -0.6, 0.1, 0.3, -0.4],
				[0.5, -0.1, 0.2, -0.9, 0.1, 0.2],
			],
		});
		const sync = buildSourceWaveformSummary({
			sourceKey: "test",
			buffer,
			bucketSize: 2,
		});
		const asyncSummary = await buildSourceWaveformSummaryAsync({
			sourceKey: "test",
			buffer,
			bucketSize: 2,
			yieldEveryBuckets: 1,
			yieldToMainThread: () => {},
		});

		expect(asyncSummary).toEqual(sync);
	});

	test("async summary yields between chunks", async () => {
		const buffer = createTestAudioBuffer({
			channels: [Array.from({ length: 10 }, (_, index) => index / 10)],
		});
		let yieldCount = 0;

		await buildSourceWaveformSummaryAsync({
			sourceKey: "chunked",
			buffer,
			bucketSize: 1,
			yieldEveryBuckets: 2,
			yieldToMainThread: () => {
				yieldCount++;
			},
		});

		expect(yieldCount).toBeGreaterThan(0);
	});
});
