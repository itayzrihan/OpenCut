import { Input, ALL_FORMATS, CanvasSink, type WrappedCanvas } from "mediabunny";
import { incrementCounter, recordSpan } from "@/diagnostics/render-perf";
import { createMediaSource } from "@/media/source";
import {
	getCanvasSourceVersion,
	markCanvasSourceVersion,
} from "@/services/renderer/canvas-source-version";

const FRAME_TIME_PRECISION = 1000;
const PREVIEW_DECODE_POOL_SIZE = 18;
const FULL_RESOLUTION_DECODE_POOL_SIZE = 3;

type CachedVideoFrame = {
	frame: WrappedCanvas;
	sourceVersion: string;
};

interface VideoSinkData {
	sinkKey: string;
	input: Input;
	sink: CanvasSink;
	frameCacheLimit: number;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	private frameCache = new Map<string, CachedVideoFrame>();
	private pendingFrameRequests = new Map<
		string,
		Promise<WrappedCanvas | null>
	>();

	async getFrameAt({
		mediaId,
		file,
		url,
		maxSourceSize,
		time,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		maxSourceSize?: number;
		time: number;
	}): Promise<WrappedCanvas | null> {
		const sinkKey = this.getSinkKey({ mediaId, maxSourceSize });
		const cachedFrame = this.getCachedFrame({ sinkKey, time });
		if (cachedFrame) {
			incrementCounter({ name: "videoCache.frameCacheHit" });
			return cachedFrame;
		}

		const requestKey = this.getFrameCacheKey({ sinkKey, time });
		const pendingRequest = this.pendingFrameRequests.get(requestKey);
		if (pendingRequest) {
			incrementCounter({ name: "videoCache.requestCoalesced" });
			return pendingRequest;
		}

		const start = performance.now();
		const request = this.loadFrameAt({
			mediaId,
			file,
			url,
			maxSourceSize,
			time,
		})
			.then((frame) => {
				if (
					frame &&
					this.sinks.has(sinkKey) &&
					this.isFrameValid({ frame, time })
				) {
					this.markFrameVersion({ sinkKey, frame });
					this.storeCachedFrame({ sinkKey, time, frame });
				}
				return frame;
			})
			.finally(() => {
				this.pendingFrameRequests.delete(requestKey);
				recordSpan({
					name: "videoCache.getFrameAt",
					durationMs: performance.now() - start,
				});
			});
		this.pendingFrameRequests.set(requestKey, request);
		return request;
	}

	private async loadFrameAt({
		mediaId,
		file,
		url,
		maxSourceSize,
		time,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		maxSourceSize?: number;
		time: number;
	}): Promise<WrappedCanvas | null> {
		const sinkKey = this.getSinkKey({ mediaId, maxSourceSize });
		await this.ensureSink({ mediaId, file, url, maxSourceSize });

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(sinkKey) ?? 0) + 1;
		this.seekGenerations.set(sinkKey, generation);

		const previous = this.frameChain.get(sinkKey) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(sinkKey) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			sinkKey,
			current.catch(() => {}),
		);
		return current;
	}

	private getSinkKey({
		mediaId,
		maxSourceSize,
	}: {
		mediaId: string;
		maxSourceSize?: number;
	}): string {
		return `${mediaId}::${maxSourceSize ? Math.max(1, Math.round(maxSourceSize)) : "full"}`;
	}

	private getFrameCacheKey({
		sinkKey,
		time,
	}: {
		sinkKey: string;
		time: number;
	}): string {
		return `${sinkKey}:${Math.round(time * FRAME_TIME_PRECISION)}`;
	}

	private getCachedFrame({
		sinkKey,
		time,
	}: {
		sinkKey: string;
		time: number;
	}): WrappedCanvas | null {
		const key = this.getFrameCacheKey({ sinkKey, time });
		const cached = this.frameCache.get(key);
		if (!cached) {
			return null;
		}
		if (
			!this.isFrameValid({ frame: cached.frame, time }) ||
			getCanvasSourceVersion({ source: cached.frame.canvas }) !==
				cached.sourceVersion
		) {
			this.frameCache.delete(key);
			return null;
		}
		this.frameCache.delete(key);
		this.frameCache.set(key, cached);
		return cached.frame;
	}

	private storeCachedFrame({
		sinkKey,
		time,
		frame,
	}: {
		sinkKey: string;
		time: number;
		frame: WrappedCanvas;
	}): void {
		const key = this.getFrameCacheKey({ sinkKey, time });
		const sourceVersion =
			getCanvasSourceVersion({ source: frame.canvas }) ??
			this.markFrameVersion({ sinkKey, frame });
		this.frameCache.delete(key);
		this.frameCache.set(key, { frame, sourceVersion });
		const frameCacheLimit = this.sinks.get(sinkKey)?.frameCacheLimit ?? 1;
		const matchingKeys = [...this.frameCache.keys()].filter((candidate) =>
			candidate.startsWith(`${sinkKey}:`),
		);
		while (matchingKeys.length > frameCacheLimit) {
			const oldestKey = matchingKeys.shift();
			if (!oldestKey) break;
			this.frameCache.delete(oldestKey);
		}
	}

	private markFrameVersion({
		sinkKey,
		frame,
	}: {
		sinkKey: string;
		frame: WrappedCanvas;
	}): string {
		const version = `${sinkKey}:${frame.timestamp}:${frame.duration}`;
		markCanvasSourceVersion({
			source: frame.canvas,
			version,
		});
		return version;
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
		url,
		maxSourceSize,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		maxSourceSize?: number;
	}): Promise<void> {
		const sinkKey = this.getSinkKey({ mediaId, maxSourceSize });
		if (this.sinks.has(sinkKey)) return;

		if (this.initPromises.has(sinkKey)) {
			await this.initPromises.get(sinkKey);
			return;
		}

		const initPromise = this.initializeSink({
			mediaId,
			file,
			url,
			maxSourceSize,
		});
		this.initPromises.set(sinkKey, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(sinkKey);
		}
	}
	private async initializeSink({
		mediaId,
		file,
		url,
		maxSourceSize,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		maxSourceSize?: number;
	}): Promise<void> {
		const sinkKey = this.getSinkKey({ mediaId, maxSourceSize });
		const input = new Input({
			source: createMediaSource({ file, url }),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const maxDimension = Math.max(
				videoTrack.displayWidth,
				videoTrack.displayHeight,
			);
			const shouldResize =
				maxSourceSize !== undefined && maxDimension > maxSourceSize;
			const previewPool = maxSourceSize !== undefined;
			const poolSize = previewPool
				? PREVIEW_DECODE_POOL_SIZE
				: FULL_RESOLUTION_DECODE_POOL_SIZE;
			const sink = new CanvasSink(videoTrack, {
				poolSize,
				fit: "contain",
				...(shouldResize &&
					(videoTrack.displayWidth >= videoTrack.displayHeight
						? { width: Math.max(1, Math.round(maxSourceSize)) }
						: { height: Math.max(1, Math.round(maxSourceSize)) })),
			});

			this.sinks.set(sinkKey, {
				sinkKey,
				input,
				sink,
				// One slot is intentionally left uncached: CanvasSink reuses pooled
				// canvases, so retaining more entries would make old cache keys point
				// at pixels from a newer frame.
				frameCacheLimit: Math.max(1, poolSize - 1),
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const matchingSinkKeys = [...this.sinks.keys()].filter((sinkKey) =>
			sinkKey.startsWith(`${mediaId}::`),
		);
		for (const sinkKey of matchingSinkKeys) {
			const sinkData = this.sinks.get(sinkKey);
			if (!sinkData) continue;
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(sinkKey);
			this.initPromises.delete(sinkKey);
			this.frameChain.delete(sinkKey);
			this.seekGenerations.delete(sinkKey);
		}

		for (const key of this.frameCache.keys()) {
			if (key.startsWith(`${mediaId}::`)) {
				this.frameCache.delete(key);
			}
		}
		for (const key of this.pendingFrameRequests.keys()) {
			if (key.startsWith(`${mediaId}::`)) {
				this.pendingFrameRequests.delete(key);
			}
		}
	}

	clearAll(): void {
		for (const sinkData of this.sinks.values()) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}
			sinkData.input.dispose();
		}
		this.sinks.clear();
		this.initPromises.clear();
		this.frameChain.clear();
		this.seekGenerations.clear();
		this.frameCache.clear();
		this.pendingFrameRequests.clear();
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames:
				Array.from(this.sinks.values()).filter((s) => s.currentFrame).length +
				this.frameCache.size,
			pendingFrameRequests: this.pendingFrameRequests.size,
		};
	}
}

export const videoCache = new VideoCache();
