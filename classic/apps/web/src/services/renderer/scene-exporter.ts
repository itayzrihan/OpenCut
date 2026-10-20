import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	VideoSampleSource,
	VideoSample,
	type Target,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import {
	getAudioBitrateCandidates,
	getPreferredAudioBitrate,
	type ExportAudioCodec,
} from "@/export/audio-quality";
import { CanvasRenderer } from "./canvas-renderer";
import { incrementCounter, measureSpanAsync } from "@/diagnostics/render-perf";

import { BoundedMemoryTarget } from "@/export/bounded-memory-target";
import type { ExportAudioStream } from "@/export/audio-stream";

export type ExportParams = {
	logicalWidth?: number;
	logicalHeight?: number;
	videoCodec?: "avc" | "hevc" | "vp9";
	videoBitrate?: number;
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	audioStream?: ExportAudioStream;
	target?: Target;
	signal?: AbortSignal;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

async function getFirstSupportedAacBitrate({
	sampleRate,
	numberOfChannels,
	bitrates,
}: {
	sampleRate: number;
	numberOfChannels: number;
	bitrates: readonly number[];
}): Promise<number | null> {
	for (const bitrate of bitrates) {
		try {
			const { supported } = await AudioEncoder.isConfigSupported({
				codec: "mp4a.40.2",
				sampleRate,
				numberOfChannels,
				bitrate,
			});
			if (supported) return bitrate;
		} catch {
			continue;
		}
	}

	return null;
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private videoCodec?: "avc" | "hevc" | "vp9";
	private videoBitrate?: number;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private audioStream?: ExportAudioStream;
	private target?: Target;
	private signal?: AbortSignal;

	private isCancelled = false;

	constructor({
		logicalWidth,
		logicalHeight,
		videoCodec,
		videoBitrate,
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		audioStream,
		target,
		signal,
	}: ExportParams) {
		super();
		this.videoCodec = videoCodec;
		this.videoBitrate = videoBitrate;
		this.renderer = new CanvasRenderer({
			logicalWidth,
			logicalHeight,
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.audioStream = audioStream;
		this.target = target;
		this.signal = signal;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | true | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);
		if (!this.target && frameCount / fpsFloat > 120)
			throw new Error("Long exports require a disk target");
		const memory = this.target ? undefined : new BoundedMemoryTarget();

		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({
						fastStart: "fragmented",
						minimumFragmentDuration: 2,
					});

		const output = new Output({
			format: outputFormat,
			target: this.target ?? memory!.target,
		});

		const videoSource = new VideoSampleSource({
			codec: this.videoCodec ?? (this.format === "webm" ? "vp9" : "avc"),
			bitrate: this.videoBitrate ?? qualityMap[this.quality],
			bitrateMode: "variable",
			latencyMode: "quality",
			keyFrameInterval: 2,
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		const audioFormat = this.audioStream ?? this.audioBuffer;
		if (this.shouldIncludeAudio && audioFormat) {
			let audioCodec: ExportAudioCodec =
				this.format === "webm" ? "opus" : "aac";
			let audioBitrate = getPreferredAudioBitrate({
				codec: audioCodec,
				quality: this.quality,
			});

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const supportedBitrate = await getFirstSupportedAacBitrate({
					sampleRate: audioFormat.sampleRate,
					numberOfChannels: audioFormat.numberOfChannels,
					bitrates: getAudioBitrateCandidates({
						codec: audioCodec,
						quality: this.quality,
					}),
				});
				if (supportedBitrate) {
					audioBitrate = supportedBitrate;
				} else {
					audioCodec = "opus";
					audioBitrate = getPreferredAudioBitrate({
						codec: audioCodec,
						quality: this.quality,
					});
				}
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: audioBitrate,
			});
			output.addAudioTrack(audioSource);
		}

		const signal = this.signal;
		const check = () => {
			signal?.throwIfAborted();
			if (this.isCancelled)
				throw new DOMException("Export cancelled", "AbortError");
		};
		// Catch asynchronous encoder callback failures as well as rejected add()
		// calls. Do not spin forever at the last percentage after an OOM.
		let lastActivity = performance.now();
		let rejectFailure!: (error: Error) => void;
		const failure = new Promise<never>((_, reject) => {
			rejectFailure = reject;
		});
		void failure.catch(() => undefined);
		const onError = (event: ErrorEvent) => {
			if (/array buffer allocation failed|out of memory/i.test(event.message))
				rejectFailure(
					new Error(
						"Export ran out of memory. The incomplete file was not published.",
					),
				);
		};
		const abort = () =>
			rejectFailure(new DOMException("Export cancelled", "AbortError"));
		signal?.addEventListener("abort", abort, { once: true });
		window.addEventListener("error", onError);
		const watchdog = setInterval(() => {
			if (this.isCancelled) abort();
			if (performance.now() - lastActivity > 120_000)
				rejectFailure(
					new Error(
						"Export made no progress for two minutes. Check source media and available disk space.",
					),
				);
		}, 1000);
		const step = async <T>(work: Promise<T>): Promise<T> => {
			check();
			const value = await Promise.race([work, failure]);
			lastActivity = performance.now();
			return value;
		};
		let pendingFrame: Promise<VideoSample> | undefined;
		let audioIterator: AsyncIterator<AudioBuffer> | undefined;
		let pendingAudio: Promise<IteratorResult<AudioBuffer>> | undefined;
		let audioEnd = 0;
		let lastReport = 0;
		const render = (i: number) =>
			measureSpanAsync({
				name: "export.renderFrame",
				fn: () =>
					this.renderer.renderAndConsume({
						node: rootNode,
						time: i * ticksPerFrame,
						consume: (canvas) =>
							new VideoSample(canvas, {
								timestamp: mediaTimeToSeconds({ time: i * ticksPerFrame }),
								duration: 1 / fpsFloat,
							}),
					}),
			});
		try {
			check();
			await step(output.start());
			if (audioSource && this.audioStream) {
				audioIterator = this.audioStream.buffers[Symbol.asyncIterator]();
				pendingAudio = audioIterator.next();
				void pendingAudio.catch(() => undefined);
			} else if (audioSource && this.audioBuffer) {
				// Compatibility for bounded renderer fixtures only. The product
				// always supplies a disk-backed audio stream.
				await step(audioSource.add(this.audioBuffer));
				audioSource.close();
			}
			if (frameCount) {
				pendingFrame = render(0);
				void pendingFrame.catch(() => undefined);
			}
			for (let i = 0; i < frameCount; i++) {
				check();
				const timeSeconds = mediaTimeToSeconds({ time: i * ticksPerFrame });
				while (audioSource && pendingAudio && audioEnd <= timeSeconds) {
					const next = await step(pendingAudio);
					pendingAudio = undefined;
					if (next.done) {
						audioSource.close();
						break;
					}
					await step(audioSource.add(next.value));
					audioEnd += next.value.duration;
					pendingAudio = audioIterator!.next();
					void pendingAudio.catch(() => undefined);
				}
				const sample = await step(pendingFrame!);
				pendingFrame = undefined;
				// Snapshot before releasing the compositor. Rendering the next frame
				// overlaps encoder/disk backpressure; only ONE extra frame is held.
				const encoding = videoSource.add(sample).finally(() => sample.close());
				void encoding.catch(() => undefined);
				if (i + 1 < frameCount) {
					pendingFrame = render(i + 1);
					void pendingFrame.catch(() => undefined);
				}
				await step(encoding);
				incrementCounter({ name: "export.frames" });
				if (performance.now() - lastReport >= 250 || i + 1 === frameCount) {
					this.emit("progress", (0.99 * (i + 1)) / frameCount);
					lastReport = performance.now();
				}
			}
			while (audioSource && pendingAudio) {
				const next = await step(pendingAudio);
				pendingAudio = undefined;
				if (next.done) break;
				await step(audioSource.add(next.value));
				pendingAudio = audioIterator!.next();
			}
			audioSource?.close();
			videoSource.close();
			await step(output.finalize());
			this.emit("progress", 1);
			if (this.target) return true;
			const buffer = memory!.finish();
			if (!buffer) throw new Error("Failed to export video");
			this.emit("complete", buffer);
			return buffer;
		} catch (error) {
			await output.cancel().catch(() => undefined);
			if (this.isCancelled || signal?.aborted) {
				this.emit("cancelled");
				return null;
			}
			throw error;
		} finally {
			clearInterval(watchdog);
			window.removeEventListener("error", onError);
			signal?.removeEventListener("abort", abort);
			// A render already in the compositor cannot be interrupted mid-frame.
			// Always release its eventual snapshot even after cancellation.
			if (pendingFrame)
				void pendingFrame.then(
					(frame) => frame.close(),
					() => undefined,
				);
			await audioIterator?.return?.();
		}
	}
}
