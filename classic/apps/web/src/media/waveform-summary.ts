"use client";

import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";

const RMS_ANALYSIS_WINDOW_SECONDS = 0.02;
const DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE = 128;
const DEFAULT_WAVEFORM_SUMMARY_YIELD_BUCKETS = 2048;

type YieldToMainThread = () => Promise<void> | void;

function getWaveformChannelData({ buffer }: { buffer: AudioBuffer }) {
	const channels = buffer.numberOfChannels;
	return Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
}

function computePeakForRange({
	channelData,
	bucketStart,
	bucketEnd,
}: {
	channelData: Float32Array[];
	bucketStart: number;
	bucketEnd: number;
}) {
	let peak = 0;
	for (let c = 0; c < channelData.length; c++) {
		const data = channelData[c];
		for (let j = bucketStart; j < bucketEnd; j++) {
			const abs = Math.abs(data[j] ?? 0);
			if (abs > peak) {
				peak = abs;
			}
		}
	}
	return peak;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

async function buildPeakAmplitudeSummaryAsync({
	channelData,
	totalSamples,
	bucketSize,
	yieldEveryBuckets,
	yieldToMainThread,
}: {
	channelData: Float32Array[];
	totalSamples: number;
	bucketSize: number;
	yieldEveryBuckets: number;
	yieldToMainThread: YieldToMainThread;
}) {
	const bucketCount = Math.max(1, Math.ceil(totalSamples / bucketSize));
	const amplitudes = new Float32Array(bucketCount);
	const safeYieldEveryBuckets = Math.max(0, Math.floor(yieldEveryBuckets));

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const bucketStart = bucketIndex * bucketSize;
		const bucketEnd = Math.min(totalSamples, bucketStart + bucketSize);
		amplitudes[bucketIndex] = computePeakForRange({
			channelData,
			bucketStart,
			bucketEnd,
		});

		if (
			safeYieldEveryBuckets > 0 &&
			bucketIndex > 0 &&
			bucketIndex < bucketCount - 1 &&
			bucketIndex % safeYieldEveryBuckets === 0
		) {
			await yieldToMainThread();
		}
	}

	return amplitudes;
}

export interface SampleBucket {
	bucketStart: number;
	bucketEnd: number;
}

export interface SourceWaveformSummary {
	sourceKey: string;
	sampleRate: number;
	totalSamples: number;
	bucketSize: number;
	amplitudes: Float32Array;
}

export interface SourceWaveformChannelSummaryInput {
	sourceKey: string;
	channelData: Float32Array[];
	sampleRate: number;
	totalSamples: number;
	bucketSize?: number;
}

export function buildWaveformSourceKey({
	kind,
	id,
}: {
	kind: "media" | "library";
	id: string;
}): string {
	return `${kind}:${id}`;
}

export function buildSourceWaveformSummary({
	sourceKey,
	buffer,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
	bucketSize?: number;
}): SourceWaveformSummary {
	return buildSourceWaveformSummaryFromChannels({
		sourceKey,
		channelData: getWaveformChannelData({ buffer }),
		sampleRate: buffer.sampleRate,
		totalSamples: buffer.length,
		bucketSize,
	});
}

export function buildSourceWaveformSummaryFromChannels({
	sourceKey,
	channelData,
	sampleRate,
	totalSamples,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
}: SourceWaveformChannelSummaryInput): SourceWaveformSummary {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const bucketCount = Math.max(1, Math.ceil(totalSamples / safeBucketSize));
	const amplitudes = new Float32Array(bucketCount);

	for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
		const bucketStart = bucketIndex * safeBucketSize;
		const bucketEnd = Math.min(totalSamples, bucketStart + safeBucketSize);
		amplitudes[bucketIndex] = computePeakForRange({
			channelData,
			bucketStart,
			bucketEnd,
		});
	}

	return {
		sourceKey,
		sampleRate,
		totalSamples,
		bucketSize: safeBucketSize,
		amplitudes,
	};
}

async function buildSourceWaveformSummaryFromChannelsAsync({
	sourceKey,
	channelData,
	sampleRate,
	totalSamples,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
	yieldEveryBuckets,
	yieldToMainThread,
}: SourceWaveformChannelSummaryInput & {
	yieldEveryBuckets: number;
	yieldToMainThread: YieldToMainThread;
}): Promise<SourceWaveformSummary> {
	const safeBucketSize = Math.max(1, Math.floor(bucketSize));
	const amplitudes = await buildPeakAmplitudeSummaryAsync({
		channelData,
		totalSamples,
		bucketSize: safeBucketSize,
		yieldEveryBuckets,
		yieldToMainThread,
	});

	return {
		sourceKey,
		sampleRate,
		totalSamples,
		bucketSize: safeBucketSize,
		amplitudes,
	};
}

export async function buildSourceWaveformSummaryAsync({
	sourceKey,
	buffer,
	bucketSize = DEFAULT_SOURCE_WAVEFORM_BUCKET_SIZE,
	yieldEveryBuckets = DEFAULT_WAVEFORM_SUMMARY_YIELD_BUCKETS,
	yieldToMainThread = yieldToEventLoop,
}: {
	sourceKey: string;
	buffer: AudioBuffer;
	bucketSize?: number;
	yieldEveryBuckets?: number;
	yieldToMainThread?: YieldToMainThread;
}): Promise<SourceWaveformSummary> {
	return buildSourceWaveformSummaryFromChannelsAsync({
		sourceKey,
		channelData: getWaveformChannelData({ buffer }),
		sampleRate: buffer.sampleRate,
		totalSamples: buffer.length,
		bucketSize,
		yieldEveryBuckets,
		yieldToMainThread,
	});
}

export function buildWaveformSampleBuckets({
	clipLeftPx,
	clipRightPx,
	barCount,
	pixelsPerSecond,
	clipDurationSec,
	sourceStartSec,
	retime,
	sampleRate,
	maxSampleExclusive,
	barStepPx,
}: {
	clipLeftPx: number;
	clipRightPx: number;
	barCount: number;
	pixelsPerSecond: number;
	clipDurationSec: number;
	sourceStartSec: number;
	retime?: RetimeConfig;
	sampleRate: number;
	maxSampleExclusive: number;
	barStepPx: number;
}): SampleBucket[] {
	return Array.from({ length: barCount }, (_, index) => {
		const bucketLeftPx = clipLeftPx + index * barStepPx;
		const bucketRightPx = Math.min(clipRightPx, bucketLeftPx + barStepPx);
		const clipStartSec = Math.max(
			0,
			Math.min(clipDurationSec, bucketLeftPx / pixelsPerSecond),
		);
		const clipEndSec = Math.max(
			clipStartSec,
			Math.min(clipDurationSec, bucketRightPx / pixelsPerSecond),
		);
		const sourceBucketStartSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipStartSec,
				retime,
			});
		const sourceBucketEndSec =
			sourceStartSec +
			getSourceTimeAtClipTime({
				clipTime: clipEndSec,
				retime,
			});

		return {
			bucketStart: Math.max(0, Math.floor(sourceBucketStartSec * sampleRate)),
			bucketEnd: Math.min(
				maxSampleExclusive,
				Math.max(0, Math.ceil(sourceBucketEndSec * sampleRate)),
			),
		};
	});
}

export function sampleSourceWaveformSummary({
	summary,
	buckets,
}: {
	summary: SourceWaveformSummary;
	buckets: SampleBucket[];
}): number[] {
	return buckets.map(({ bucketStart, bucketEnd }) => {
		if (bucketEnd <= bucketStart) {
			return 0;
		}

		const startIndex = Math.max(
			0,
			Math.floor(bucketStart / summary.bucketSize),
		);
		const endIndex = Math.min(
			summary.amplitudes.length,
			Math.max(startIndex + 1, Math.ceil(bucketEnd / summary.bucketSize)),
		);

		let maxAmplitude = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const amplitude = summary.amplitudes[i] ?? 0;
			if (amplitude > maxAmplitude) {
				maxAmplitude = amplitude;
			}
		}

		return maxAmplitude;
	});
}

export function computeRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	const channels = buffer.numberOfChannels;
	const maxWindowLength = Math.max(
		1,
		Math.floor(buffer.sampleRate * RMS_ANALYSIS_WINDOW_SECONDS),
	);

	const channelData: Float32Array[] = new Array(channels);
	for (let c = 0; c < channels; c++) {
		channelData[c] = buffer.getChannelData(c);
	}

	const result = new Array<number>(buckets.length);

	for (let i = 0; i < buckets.length; i++) {
		const { bucketStart, bucketEnd } = buckets[i];
		const bucketLength = bucketEnd - bucketStart;
		if (bucketLength <= 0) {
			result[i] = 0;
			continue;
		}

		const windowLength = Math.max(1, Math.min(bucketLength, maxWindowLength));
		let maxMeanSquare = 0;

		for (let winStart = bucketStart; winStart < bucketEnd; ) {
			const winEnd = Math.min(winStart + windowLength, bucketEnd);
			const n = winEnd - winStart;
			if (n > 0) {
				let sum = 0;
				for (let c = 0; c < channels; c++) {
					const data = channelData[c];
					for (let j = winStart; j < winEnd; j++) {
						const v = data[j];
						sum += v * v;
					}
				}
				const meanSquare = sum / (n * channels);
				if (meanSquare > maxMeanSquare) {
					maxMeanSquare = meanSquare;
				}
			}
			winStart = winEnd;
		}

		result[i] = Math.sqrt(maxMeanSquare);
	}

	return result;
}
