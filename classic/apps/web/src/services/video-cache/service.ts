import { Input, ALL_FORMATS, CanvasSink, type WrappedCanvas } from "mediabunny";
import { incrementCounter, recordSpan } from "@/diagnostics/render-perf";
import { createMediaSource } from "@/media/source";

const FRAME_CACHE_LIMIT = 48;
const FRAME_TIME_PRECISION = 1000;

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
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
	private frameCache = new Map<string, WrappedCanvas>();
	private pendingFrameRequests = new Map<
		string,
		Promise<WrappedCanvas | null>
	>();

	async getFrameAt({
		mediaId,
		file,
		url,
		time,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		time: number;
	}): Promise<WrappedCanvas | null> {
		const cachedFrame = this.getCachedFrame({ mediaId, time });
		if (cachedFrame) {
			incrementCounter({ name: "videoCache.frameCacheHit" });
			return cachedFrame;
		}

		const requestKey = this.getFrameCacheKey({ mediaId, time });
		const pendingRequest = this.pendingFrameRequests.get(requestKey);
		if (pendingRequest) {
			incrementCounter({ name: "videoCache.requestCoalesced" });
			return pendingRequest;
		}

		const start = performance.now();
		const request = this.loadFrameAt({ mediaId, file, url, time })
			.then((frame) => {
				if (
					frame &&
					this.sinks.has(mediaId) &&
					this.isFrameValid({ frame, time })
				) {
					this.storeCachedFrame({ mediaId, time, frame });
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
		time,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
		time: number;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file, url });

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		const generation = (this.seekGenerations.get(mediaId) ?? 0) + 1;
		this.seekGenerations.set(mediaId, generation);

		const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
		const current = previous.then(() => {
			if (this.seekGenerations.get(mediaId) !== generation) {
				return sinkData.currentFrame ?? null;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			mediaId,
			current.catch(() => {}),
		);
		return current;
	}

	private getFrameCacheKey({
		mediaId,
		time,
	}: {
		mediaId: string;
		time: number;
	}): string {
		return `${mediaId}:${Math.round(time * FRAME_TIME_PRECISION)}`;
	}

	private getCachedFrame({
		mediaId,
		time,
	}: {
		mediaId: string;
		time: number;
	}): WrappedCanvas | null {
		const key = this.getFrameCacheKey({ mediaId, time });
		const frame = this.frameCache.get(key);
		if (!frame) {
			return null;
		}
		if (!this.isFrameValid({ frame, time })) {
			this.frameCache.delete(key);
			return null;
		}
		this.frameCache.delete(key);
		this.frameCache.set(key, frame);
		return frame;
	}

	private storeCachedFrame({
		mediaId,
		time,
		frame,
	}: {
		mediaId: string;
		time: number;
		frame: WrappedCanvas;
	}): void {
		const key = this.getFrameCacheKey({ mediaId, time });
		this.frameCache.delete(key);
		this.frameCache.set(key, frame);
		while (this.frameCache.size > FRAME_CACHE_LIMIT) {
			const oldestKey = this.frameCache.keys().next().value;
			if (oldestKey === undefined) break;
			this.frameCache.delete(oldestKey);
		}
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
	}: {
		mediaId: string;
		file?: File;
		url?: string;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file, url });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
		url,
	}: {
		mediaId: string;
		file?: File;
		url?: string;
	}): Promise<void> {
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

			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
			});

			this.sinks.set(mediaId, {
				input,
				sink,
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
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);
		for (const key of this.frameCache.keys()) {
			if (key.startsWith(`${mediaId}:`)) {
				this.frameCache.delete(key);
			}
		}
		for (const key of this.pendingFrameRequests.keys()) {
			if (key.startsWith(`${mediaId}:`)) {
				this.pendingFrameRequests.delete(key);
			}
		}
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
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
