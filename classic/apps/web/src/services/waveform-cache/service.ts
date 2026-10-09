"use client";

import { buildStreamingSourceWaveformSummary } from "./streaming";
import {
	buildSourceWaveformSummaryAsync,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import { buildStreamingWaveformInWorker } from "./streaming-client";
import { isRenderPerfEnabled } from "@/diagnostics/render-perf";
import { publishPerformanceReport } from "@/diagnostics/performance-reports";
import type { WaveformWorkerMessage, WaveformWorkerResponse } from "./worker";

const WAVEFORM_WORKER_MIN_TOTAL_SAMPLES = 1_000_000;

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

export class WaveformCache {
	private summaries = new Map<string, Promise<SourceWaveformSummary>>();
	private buildQueue: Promise<void> = Promise.resolve();
	private controllers = new Map<string, AbortController>();

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

		const controller = new AbortController();
		this.controllers.set(sourceKey, controller);
		const promise = this.buildQueue
			.catch(() => undefined)
			.then(() =>
				this.buildSummary({
					sourceKey,
					audioBuffer,
					sourceFile,
					audioUrl,
					signal: controller.signal,
				}),
			)
			.catch((error) => {
				if (this.controllers.get(sourceKey) === controller)
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
		this.controllers.get(sourceKey)?.abort();
		this.controllers.delete(sourceKey);
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		for (const controller of this.controllers.values()) controller.abort();
		this.controllers.clear();
		this.summaries.clear();
	}

	private async buildSummary({
		signal,
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs & {
		signal: AbortSignal;
	}): Promise<SourceWaveformSummary> {
		signal.throwIfAborted();
		if (audioBuffer) {
			return this.buildSummaryForBuffer({
				sourceKey,
				buffer: audioBuffer,
			});
		}

		if (!sourceFile && !audioUrl) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const start = performance.now();
		let mode = "main";
		const forceMain =
			isRenderPerfEnabled() &&
			new URLSearchParams(window.location.search).get("waveformThread") ===
				"main";
		try {
			if (typeof Worker !== "undefined" && !forceMain) {
				try {
					const result = await buildStreamingWaveformInWorker({
						sourceKey,
						sourceFile,
						audioUrl,
						signal,
					});
					mode = "worker";
					return result;
				} catch (error) {
					signal.throwIfAborted();
					mode = "fallback";
					console.warn(
						"Streaming waveform worker failed; using original path",
						error,
					);
				}
			}
			return await buildStreamingSourceWaveformSummary({
				sourceKey,
				sourceFile,
				audioUrl,
				useAudioBuffer: true,
				signal,
			});
		} finally {
			if (isRenderPerfEnabled())
				publishPerformanceReport({
					kind: "waveform",
					data: {
						mode,
						durationMs: performance.now() - start,
						cancelled: signal.aborted,
					},
				});
		}
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
