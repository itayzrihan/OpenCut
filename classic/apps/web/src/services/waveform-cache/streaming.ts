import {
	ALL_FORMATS,
	AudioSampleSink,
	AudioBufferSink,
	Input,
} from "mediabunny";
import { createMediaSource } from "@/media/source";
import type { SourceWaveformSummary } from "@/media/waveform-summary";
const STREAMING_WAVEFORM_WINDOW_SECONDS = 0.01;
const STREAMING_WAVEFORM_MAX_BUCKETS = 500_000;
const STREAMING_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
// Shared aggregation; the fallback retains AudioBufferSink while workers use AudioSample.
export async function buildStreamingSourceWaveformSummary({
	sourceKey,
	sourceFile,
	audioUrl,
	useAudioBuffer = false,
	signal,
}: {
	sourceKey: string;
	sourceFile?: File;
	audioUrl?: string;
	useAudioBuffer?: boolean;
	signal?: AbortSignal;
}): Promise<SourceWaveformSummary> {
	signal?.throwIfAborted();
	const input = new Input({
		source: createMediaSource({
			file: sourceFile,
			url: audioUrl,
			urlOptions: {
				maxCacheSize: STREAMING_SOURCE_CACHE_BYTES,
				parallelism: 1,
			},
		}),
		formats: ALL_FORMATS,
	});

	const abort = () => input.dispose();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			throw new Error(`Waveform source ${sourceKey} has no audio track`);
		}

		const sampleRate = audioTrack.sampleRate;
		if (!(sampleRate > 0)) {
			throw new Error(`Waveform source ${sourceKey} has no sample rate`);
		}

		const duration = await audioTrack.computeDuration();
		const estimatedTotalSamples = Math.max(
			1,
			Math.ceil(Math.max(0, duration) * sampleRate),
		);
		const bucketSize = Math.max(
			128,
			Math.ceil(sampleRate * STREAMING_WAVEFORM_WINDOW_SECONDS),
			Math.ceil(estimatedTotalSamples / STREAMING_WAVEFORM_MAX_BUCKETS),
		);
		let amplitudes = new Float32Array(
			Math.max(1, Math.ceil(estimatedTotalSamples / bucketSize)),
		);
		let decodedEndSample = 0;

		const ensureBucket = (bucketIndex: number) => {
			if (bucketIndex < amplitudes.length) return;
			const grown = new Float32Array(
				Math.max(bucketIndex + 1, amplitudes.length * 2),
			);
			grown.set(amplitudes);
			amplitudes = grown;
		};

		async function* chunks() {
			if (useAudioBuffer) {
				yield* new AudioBufferSink(audioTrack!).buffers(0);
				return;
			}
			for await (const sample of new AudioSampleSink(audioTrack!).samples(0)) {
				try {
					const channels = Array.from(
						{ length: sample.numberOfChannels },
						(_, channel) => {
							const data = new Float32Array(sample.numberOfFrames);
							sample.copyTo(data, {
								planeIndex: channel,
								format: "f32-planar",
							});
							return data;
						},
					);
					yield {
						timestamp: sample.timestamp,
						buffer: {
							length: sample.numberOfFrames,
							numberOfChannels: sample.numberOfChannels,
							getChannelData: (channel: number) => channels[channel],
						},
					};
				} finally {
					sample.close();
				}
			}
		}
		for await (const { buffer, timestamp } of chunks()) {
			signal?.throwIfAborted();
			const rawStartSample = Math.round(timestamp * sampleRate);
			let bufferOffset = Math.max(0, -rawStartSample);
			const absoluteStartSample = Math.max(0, rawStartSample);
			const channelData = Array.from(
				{ length: buffer.numberOfChannels },
				(_, channel) => buffer.getChannelData(channel),
			);

			while (bufferOffset < buffer.length) {
				const absoluteSample = absoluteStartSample + bufferOffset;
				const bucketIndex = Math.floor(absoluteSample / bucketSize);
				ensureBucket(bucketIndex);
				const bucketEndSample = (bucketIndex + 1) * bucketSize;
				const segmentLength = Math.min(
					buffer.length - bufferOffset,
					bucketEndSample - absoluteSample,
				);
				const segmentEnd = bufferOffset + segmentLength;
				let peak = amplitudes[bucketIndex] ?? 0;

				for (const channel of channelData) {
					for (let sample = bufferOffset; sample < segmentEnd; sample++) {
						peak = Math.max(peak, Math.abs(channel[sample] ?? 0));
					}
				}
				amplitudes[bucketIndex] = peak;
				bufferOffset = segmentEnd;
			}

			decodedEndSample = Math.max(
				decodedEndSample,
				absoluteStartSample + buffer.length,
			);
		}

		if (decodedEndSample === 0) {
			throw new Error(`Waveform source ${sourceKey} has no decodable audio`);
		}

		const totalSamples = Math.max(estimatedTotalSamples, decodedEndSample);
		const bucketCount = Math.max(1, Math.ceil(totalSamples / bucketSize));
		return {
			sourceKey,
			sampleRate,
			totalSamples,
			bucketSize,
			amplitudes: amplitudes.slice(0, bucketCount),
		};
	} finally {
		signal?.removeEventListener("abort", abort);
		input.dispose();
	}
}
