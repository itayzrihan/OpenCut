"use client";

import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource } from "@/media/source";
import {
	buildSourceWaveformSummaryAsync,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import type { WaveformWorkerMessage, WaveformWorkerResponse } from "./worker";

const WAVEFORM_WORKER_MIN_TOTAL_SAMPLES = 1_000_000;
const STREAMING_WAVEFORM_WINDOW_SECONDS = 0.01;
const STREAMING_WAVEFORM_MAX_BUCKETS = 500_000;
const STREAMING_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

export function shouldUseWaveformWorker({
	totalSamples,
	channelCount,
	isWorkerAvailable = typeof Worker !== "undefined",
}: {
	totalSamples: number;
	channelCount: number;
	isWorkerAvailable?: boolean;
}): boolean {
	return (
		isWorkerAvailable &&
		Math.max(0, totalSamples) * Math.max(1, channelCount) >=
			WAVEFORM_WORKER_MIN_TOTAL_SAMPLES
	);
}

function cloneAudioBufferChannelData({
	buffer,
}: {
	buffer: AudioBuffer;
}): Float32Array[] {
	return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
		Float32Array.from(buffer.getChannelData(channel)),
	);
}

function getTransferableBuffers({
	channelData,
}: {
	channelData: Float32Array[];
}): Transferable[] {
	return channelData
		.map((channel) => channel.buffer)
		.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
}

async function buildSourceWaveformSummaryInWorker({
	sourceKey,
	buffer,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
}): Promise<SourceWaveformSummary> {
	const worker = new Worker(new URL("./worker.ts", import.meta.url), {
		type: "module",
	});
	const channelData = cloneAudioBufferChannelData({ buffer });
	const transferableBuffers = getTransferableBuffers({ channelData });

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			worker.removeEventListener("message", handleMessage);
			worker.removeEventListener("error", handleError);
			worker.terminate();
		};
		const handleMessage = (event: MessageEvent<WaveformWorkerResponse>) => {
			const response = event.data;
			cleanup();
			if (response.type === "build-summary-complete") {
				resolve(response.summary);
			} else {
				reject(new Error(response.error));
			}
		};
		const handleError = (event: ErrorEvent) => {
			cleanup();
			reject(
				event.error instanceof Error ? event.error : new Error(event.message),
			);
		};

		worker.addEventListener("message", handleMessage);
		worker.addEventListener("error", handleError);
		worker.postMessage(
			{
				type: "build-summary",
				sourceKey,
				channelData,
				sampleRate: buffer.sampleRate,
				totalSamples: buffer.length,
			} satisfies WaveformWorkerMessage,
			transferableBuffers,
		);
	});
}

async function buildStreamingSourceWaveformSummary({
	sourceKey,
	sourceFile,
	audioUrl,
}: {
	sourceKey: string;
	sourceFile?: File;
	audioUrl?: string;
}): Promise<SourceWaveformSummary> {
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

		const sink = new AudioBufferSink(audioTrack);
		for await (const { buffer, timestamp } of sink.buffers(0)) {
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
		input.dispose();
	}
}

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();
	private buildQueue: Promise<void> = Promise.resolve();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.buildQueue
			.catch(() => undefined)
			.then(() =>
				this.buildSummary({
					sourceKey,
					audioBuffer,
					sourceFile,
					audioUrl,
				}),
			)
			.catch((error) => {
			this.summaries.delete(sourceKey);
			throw error;
		});
		this.buildQueue = promise.then(
			() => undefined,
			() => undefined,
		);

		this.summaries.set(sourceKey, promise);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return this.buildSummaryForBuffer({
				sourceKey,
				buffer: audioBuffer,
			});
		}

		if (!sourceFile && !audioUrl) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		return buildStreamingSourceWaveformSummary({
			sourceKey,
			sourceFile,
			audioUrl,
		});
	}

	private async buildSummaryForBuffer({
		sourceKey,
		buffer,
	}: {
		sourceKey: string;
		buffer: AudioBuffer;
	}): Promise<SourceWaveformSummary> {
		if (
			shouldUseWaveformWorker({
				totalSamples: buffer.length,
				channelCount: buffer.numberOfChannels,
			})
		) {
			try {
				return await buildSourceWaveformSummaryInWorker({ sourceKey, buffer });
			} catch (error) {
				console.warn(
					"Waveform worker failed; falling back to async summary",
					error,
				);
			}
		}

		return buildSourceWaveformSummaryAsync({ sourceKey, buffer });
	}
}

export const waveformCache = new WaveformCache();
