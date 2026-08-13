import type { EditorCore } from "@/core";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { clampRetimeRate } from "@/retime/rate";
import type { AudioClipSource } from "@/media/audio";
import { createAudioContext, collectAudioClips } from "@/media/audio";
import {
	buildAudioGainAutomation,
	hasVariableAudioGain,
} from "@/timeline/audio-state";
import { createAudioMasteringChain } from "@/media/audio-mastering";
import {
	getClipTimeAtSourceTime,
	getSourceTimeAtClipTime,
	renderRetimedBuffer,
} from "@/retime";
import {
	ALL_FORMATS,
	AudioBufferSink,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";
import { createMediaSource } from "@/media/source";
import {
	getAudibleContextTime,
	getAudioContextStartTime,
	getAudioRecoveryTimelineTime,
	getStreamingSourceDuration,
	mapRetimeToTimelineScale,
} from "@/core/managers/audio-sync";
import type { TScene, TimelineElement } from "@/timeline";

type ParallaxAudioScope = {
	scene: TScene;
	parentStartTime: number;
	parentDuration: number;
	childDuration: number;
};

function getParallaxAudioScope({
	editor,
}: {
	editor: EditorCore;
}): ParallaxAudioScope | null {
	const childScene = editor.scenes.getActiveScene();
	if (!childScene.parallax) return null;

	const parentScene = editor.scenes
		.getScenes()
		.find((scene) => scene.id === childScene.parallax?.parentSceneId);
	if (!parentScene) return null;

	let parentElement: TimelineElement | undefined;
	for (const track of [
		parentScene.tracks.main,
		...parentScene.tracks.overlay,
	]) {
		parentElement = track.elements.find(
			(element) => element.id === childScene.parallax?.parentElementId,
		);
		if (parentElement) break;
	}
	if (!parentElement || parentElement.duration <= 0) return null;

	const childDuration = editor.timeline.getTotalDuration();
	if (childDuration <= 0) return null;

	return {
		scene: parentScene,
		parentStartTime: parentElement.startTime / TICKS_PER_SECOND,
		parentDuration: parentElement.duration / TICKS_PER_SECOND,
		childDuration: childDuration / TICKS_PER_SECOND,
	};
}

function mapParallaxAudioClips({
	clips,
	scope,
}: {
	clips: AudioClipSource[];
	scope: ParallaxAudioScope;
}): AudioClipSource[] {
	const parentEndTime = scope.parentStartTime + scope.parentDuration;
	const timeScale = scope.parentDuration / Math.max(0.001, scope.childDuration);

	return clips.flatMap((clip) => {
		const clipEndTime = clip.startTime + clip.duration;
		const overlapStart = Math.max(clip.startTime, scope.parentStartTime);
		const overlapEnd = Math.min(clipEndTime, parentEndTime);
		if (overlapEnd <= overlapStart) return [];

		const sourceOffset = overlapStart - clip.startTime;
		const mappedStartTime = (overlapStart - scope.parentStartTime) / timeScale;
		const mappedDuration = (overlapEnd - overlapStart) / timeScale;
		const mappedTrimStart =
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: sourceOffset,
				retime: clip.retime,
			});
		const mappedRetime = mapRetimeToTimelineScale({
			retime: clip.retime,
			timelineScale: timeScale,
		});

		return [
			{
				...clip,
				startTime: mappedStartTime,
				duration: mappedDuration,
				trimStart: mappedTrimStart,
				retime: mappedRetime,
				timelineElement: {
					...clip.timelineElement,
					startTime: mediaTimeFromSeconds({ seconds: mappedStartTime }),
					duration: mediaTimeFromSeconds({ seconds: mappedDuration }),
					trimStart: mediaTimeFromSeconds({ seconds: mappedTrimStart }),
					retime: mappedRetime,
				},
			},
		];
	});
}

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private scheduleTimer: number | null = null;
	private lookaheadSeconds = 4;
	private scheduleIntervalMs = 250;
	private streamingAheadSeconds = 3;
	private clips: AudioClipSource[] = [];
	private audioClipsReady = false;
	private audioClipsPromise: Promise<void> | null = null;
	private audioCacheGeneration = 0;
	private sinks = new Map<string, AudioBufferSink>();
	private inputs = new Map<string, Input>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<WrappedAudioBuffer, void, unknown>
	>();
	private queuedSources = new Set<AudioBufferSourceNode>();
	private scheduledClipIds = new Set<string>();
	private preparedClipBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private decodedBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private clipRetryTimers = new Map<string, number>();
	private clipRetryAttempts = new Map<string, number>();
	private playbackSessionId = 0;
	private lastIsPlaying = false;
	private lastVolume = 1;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.registerPlaybackPreparer({
				id: "timeline-audio",
				prepare: this.preparePlayback,
			}),
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.scenes.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
			this.editor.playback.onSeek(this.handleSeek),
		);

		if (typeof window !== "undefined") {
			const retryAudioUnlock = () => {
				const audioContext = this.audioContext;
				if (!audioContext || audioContext.state !== "suspended") {
					return;
				}

				void audioContext
					.resume()
					.then(() => {
						if (this.editor.playback.getIsPlaying()) {
							void this.startPlayback();
						}
					})
					.catch(() => {
						// Browsers can reject resume until a later user gesture.
					});
			};
			window.addEventListener("pointerdown", retryAudioUnlock, {
				passive: true,
			});
			window.addEventListener("keydown", retryAudioUnlock);
			this.unsubscribers.push(() => {
				window.removeEventListener("pointerdown", retryAudioUnlock);
				window.removeEventListener("keydown", retryAudioUnlock);
			});
		}
	}

	dispose(): void {
		this.stopPlayback();
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.disposeSinks();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();
		if (this.audioContext) {
			void this.audioContext.close();
			this.audioContext = null;
			this.masterGain = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback();
			} else {
				this.stopPlayback();
			}
		}
	};

	private handleSeek = (_time: number): void => {
		if (this.editor.playback.getIsScrubbing()) {
			this.stopPlayback();
			return;
		}

		if (this.editor.playback.getIsPlaying()) {
			void this.startPlayback();
			return;
		}

		this.stopPlayback();
	};

	private handleTimelineChange = (): void => {
		this.disposeSinks();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();
		this.clips = [];
		this.audioClipsReady = false;
		this.audioClipsPromise = null;
		this.audioCacheGeneration++;

		if (!this.editor.playback.getIsPlaying()) return;

		void this.startPlayback();
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		const { input } = createAudioMasteringChain({
			audioContext: this.audioContext,
			destination: this.audioContext.destination,
		});
		this.masterGain = input;
		this.masterGain.gain.value = this.lastVolume;
		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private getPlaybackTime(): number {
		return this.editor.playback.getClockTime() / TICKS_PER_SECOND;
	}

	private getContextStartTime({
		audioContext,
		timelineTime,
	}: {
		audioContext: AudioContext;
		timelineTime: number;
	}): number {
		const outputTimestamp =
			typeof audioContext.getOutputTimestamp === "function"
				? audioContext.getOutputTimestamp()
				: undefined;
		const outputLatency = audioContext.outputLatency;
		const baseLatency = audioContext.baseLatency;
		const reportedOutputLatency =
			Number.isFinite(outputLatency) && outputLatency > 0
				? outputLatency
				: Number.isFinite(baseLatency) && baseLatency > 0
					? baseLatency
					: 0;
		const audibleContextTime = getAudibleContextTime({
			contextTime: audioContext.currentTime,
			performanceTime: performance.now(),
			outputTimestamp,
			outputLatency: reportedOutputLatency,
		});

		return getAudioContextStartTime({
			audibleContextTime,
			playbackTime: this.getPlaybackTime(),
			timelineTime,
		});
	}

	private preparePlayback = async ({
		time,
		lookaheadSeconds,
		signal,
	}: {
		time: number;
		lookaheadSeconds: number;
		signal: AbortSignal;
	}): Promise<void> => {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;
		if (audioContext.state === "suspended") {
			try {
				await audioContext.resume();
			} catch {
				return;
			}
		}
		if (signal.aborted || audioContext.state !== "running") return;

		await this.ensureCurrentAudioClips({ signal });
		if (signal.aborted) return;

		const currentTime = time / TICKS_PER_SECOND;
		const windowEnd = currentTime + lookaheadSeconds;
		const upcoming = this.clips.filter(
			(clip) =>
				!clip.muted &&
				clip.startTime < windowEnd &&
				clip.startTime + clip.duration > currentTime,
		);
		await Promise.all(
			upcoming.map(async (clip) => {
				if (signal.aborted) return;
				if (this.shouldUsePreparedClipBuffer({ clip })) {
					await this.getPreparedClipBuffer({ clip });
				} else {
					await this.getAudioSink({ clip });
				}
			}),
		);
		if (signal.aborted) return;
		const generation = this.audioCacheGeneration;
		const initiallyPreparedIds = new Set(upcoming.map((clip) => clip.id));
		void this.prepareRemainingPlaybackAudio({
			generation,
			excludeClipIds: initiallyPreparedIds,
		});
	};

	private async prepareRemainingPlaybackAudio({
		generation,
		excludeClipIds,
	}: {
		generation: number;
		excludeClipIds: ReadonlySet<string>;
	}): Promise<void> {
		for (const clip of this.clips) {
			if (generation !== this.audioCacheGeneration) return;
			if (clip.muted || excludeClipIds.has(clip.id)) continue;
			try {
				if (this.shouldUsePreparedClipBuffer({ clip })) {
					await this.getPreparedClipBuffer({ clip });
				}
			} catch (error) {
				console.warn(`Failed to prebuffer audio clip ${clip.id}:`, error);
			}
		}
	}

	private async ensureCurrentAudioClips({
		signal,
	}: {
		signal?: AbortSignal;
	} = {}): Promise<void> {
		if (this.audioClipsReady) return;
		if (this.audioClipsPromise) {
			await this.audioClipsPromise;
			return;
		}

		const generation = this.audioCacheGeneration;
		const promise = this.collectCurrentAudioClips({ generation });
		this.audioClipsPromise = promise;
		try {
			await promise;
		} finally {
			if (this.audioClipsPromise === promise) {
				this.audioClipsPromise = null;
			}
		}
		if (signal?.aborted) return;
	}

	private async collectCurrentAudioClips({
		generation,
	}: {
		generation: number;
	}): Promise<void> {
		const activeScene = this.editor.scenes.getActiveScene();
		const nestedAudioScope = getParallaxAudioScope({ editor: this.editor });
		const tracks = nestedAudioScope?.scene.tracks ?? activeScene.tracks;
		const mediaAssets = this.editor.media.getAssets();
		const clips = await collectAudioClips({
			tracks,
			mediaAssets,
			onClips: (nextClips) => {
				if (generation !== this.audioCacheGeneration) return;
				this.clips = nestedAudioScope
					? mapParallaxAudioClips({ clips: nextClips, scope: nestedAudioScope })
					: nextClips;
				if (this.editor.playback.getIsPlaying()) {
					this.scheduleUpcomingClips();
				}
			},
		});
		if (generation !== this.audioCacheGeneration) return;
		this.clips = nestedAudioScope
			? mapParallaxAudioClips({ clips, scope: nestedAudioScope })
			: clips;
		this.audioClipsReady = true;
	}

	private async startPlayback(): Promise<void> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return;

		this.stopPlayback();
		const sessionId = this.playbackSessionId;

		const duration = this.editor.timeline.getTotalDuration();

		if (duration <= 0) return;

		if (audioContext.state === "suspended") {
			try {
				await audioContext.resume();
			} catch {
				// The browser may require a user gesture. The unlock listeners above
				// will retry without losing the playback timeline.
				return;
			}
		}
		if (audioContext.state !== "running") {
			return;
		}
		if (
			sessionId !== this.playbackSessionId ||
			!this.editor.playback.getIsPlaying()
		) {
			return;
		}

		this.ensureScheduleTimer();

		try {
			await this.ensureCurrentAudioClips();
		} catch (error) {
			console.warn("Failed to collect timeline audio clips:", error);
			return;
		}
		if (
			sessionId !== this.playbackSessionId ||
			!this.editor.playback.getIsPlaying()
		) {
			return;
		}
		this.scheduleUpcomingClips();
	}

	private ensureScheduleTimer(): void {
		if (typeof window === "undefined" || this.scheduleTimer !== null) {
			return;
		}

		this.scheduleTimer = window.setInterval(() => {
			this.scheduleUpcomingClips();
		}, this.scheduleIntervalMs);
	}

	private scheduleUpcomingClips(): void {
		if (!this.editor.playback.getIsPlaying()) return;

		const currentTime = this.getPlaybackTime();
		const windowEnd = currentTime + this.lookaheadSeconds;

		for (const clip of this.clips) {
			if (clip.muted) continue;
			if (this.activeClipIds.has(clip.id)) continue;
			if (this.clipRetryTimers.has(clip.id)) continue;

			const clipEnd = clip.startTime + clip.duration;
			if (clipEnd <= currentTime) continue;
			if (clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			this.scheduleClip({
				clip,
				startTime: currentTime,
				sessionId: this.playbackSessionId,
			});
		}
	}

	private scheduleClip({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): void {
		const schedulePromise = this.shouldUsePreparedClipBuffer({ clip })
			? this.schedulePreparedClip({ clip, startTime, sessionId })
			: this.runClipIterator({ clip, startTime, sessionId });

		void schedulePromise.then(
			(started) => {
				if (started) {
					this.clipRetryAttempts.delete(clip.id);
					return;
				}

				this.retryClip({ clipId: clip.id, sessionId });
			},
			(error: unknown) => {
				console.warn(`Failed to schedule audio clip ${clip.id}:`, error);
				if (!this.scheduledClipIds.has(clip.id)) {
					this.retryClip({ clipId: clip.id, sessionId });
				}
			},
		);
	}

	private retryClip({
		clipId,
		sessionId,
	}: {
		clipId: string;
		sessionId: number;
	}): void {
		if (
			sessionId !== this.playbackSessionId ||
			!this.editor.playback.getIsPlaying()
		) {
			return;
		}

		this.activeClipIds.delete(clipId);
		if (typeof window === "undefined" || this.clipRetryTimers.has(clipId)) {
			return;
		}

		const attempt = (this.clipRetryAttempts.get(clipId) ?? 0) + 1;
		if (attempt > 8) {
			console.warn(`Giving up audio retries for clip ${clipId} this session.`);
			return;
		}
		this.clipRetryAttempts.set(clipId, attempt);

		const delayMs = Math.min(1000, 100 * 2 ** (attempt - 1));
		const timer = window.setTimeout(() => {
			this.clipRetryTimers.delete(clipId);
			if (
				sessionId === this.playbackSessionId &&
				this.editor.playback.getIsPlaying()
			) {
				this.scheduleUpcomingClips();
			}
		}, delayMs);
		this.clipRetryTimers.set(clipId, timer);
	}

	private stopPlayback(): void {
		this.playbackSessionId++;

		if (this.scheduleTimer && typeof window !== "undefined") {
			window.clearInterval(this.scheduleTimer);
		}
		this.scheduleTimer = null;
		for (const timer of this.clipRetryTimers.values()) {
			if (typeof window !== "undefined") {
				window.clearTimeout(timer);
			}
		}
		this.clipRetryTimers.clear();
		this.clipRetryAttempts.clear();

		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();
		this.scheduledClipIds.clear();

		for (const source of this.queuedSources) {
			try {
				source.stop();
			} catch {
				// A source that ended naturally is already stopped.
			}
			source.disconnect();
		}
		this.queuedSources.clear();
	}

	private async runClipIterator({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<boolean> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return false;

		const sink = await this.getAudioSink({ clip });
		if (!sink || !this.editor.playback.getIsPlaying()) return false;
		if (sessionId !== this.playbackSessionId) return false;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterSinkReady = this.getPlaybackTime();
		let iteratorStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterSinkReady,
		);
		let currentIterator: AsyncGenerator<
			WrappedAudioBuffer,
			void,
			unknown
		> | null = null;
		let scheduledSource = false;

		while (iteratorStartTime < clipEnd) {
			if (!this.editor.playback.getIsPlaying()) return scheduledSource;
			if (sessionId !== this.playbackSessionId) return scheduledSource;

			const sourceStartTime =
				clip.trimStart +
				getSourceTimeAtClipTime({
					clipTime: iteratorStartTime - clip.startTime,
					retime: clip.retime,
				});
			const iterator = sink.buffers(sourceStartTime);
			currentIterator = iterator;
			this.clipIterators.set(clip.id, iterator);
			let recoveryStartTime: number | null = null;

			for await (const { buffer, timestamp } of iterator) {
				if (!this.editor.playback.getIsPlaying()) return scheduledSource;
				if (sessionId !== this.playbackSessionId) return scheduledSource;

				const timelineTime =
					clip.startTime +
					getClipTimeAtSourceTime({
						sourceTime: timestamp - clip.trimStart,
						retime: clip.retime,
					});
				if (timelineTime >= clipEnd) break;

				const startTimestamp = this.getContextStartTime({
					audioContext,
					timelineTime,
				});
				const playbackRate = clip.retime
					? clampRetimeRate({ rate: clip.retime.rate })
					: 1;
				const contextLateness = Math.max(
					0,
					audioContext.currentTime - startTimestamp,
				);
				const sourceOffset = contextLateness * playbackRate;
				const sourceDuration = getStreamingSourceDuration({
					bufferDuration: buffer.duration,
					sourceOffset,
					playbackRate,
					bufferTimelineTime: timelineTime,
					clipEndTime: clipEnd,
					contextLateness,
				});

				if (sourceDuration <= 0) {
					if (timelineTime + contextLateness >= clipEnd) break;
					recoveryStartTime = getAudioRecoveryTimelineTime({
						bufferTimelineTime: timelineTime,
						contextStartTime: startTimestamp,
						currentContextTime: audioContext.currentTime,
						playbackTime: this.getPlaybackTime(),
					});
					break;
				}

				const node = audioContext.createBufferSource();
				node.buffer = buffer;
				node.playbackRate.value = playbackRate;
				const clipGain = audioContext.createGain();
				clipGain.gain.value = clip.volume;
				node.connect(clipGain);
				clipGain.connect(this.masterGain ?? audioContext.destination);
				node.start(
					Math.max(startTimestamp, audioContext.currentTime),
					sourceOffset,
					sourceDuration,
				);
				scheduledSource = true;
				this.scheduledClipIds.add(clip.id);

				this.queuedSources.add(node);
				node.addEventListener("ended", () => {
					node.disconnect();
					clipGain.disconnect();
					this.queuedSources.delete(node);
				});

				const aheadTime = timelineTime - this.getPlaybackTime();
				if (aheadTime >= this.streamingAheadSeconds) {
					await this.waitUntilCaughtUp({
						timelineTime,
						targetAhead: this.streamingAheadSeconds,
					});
					if (sessionId !== this.playbackSessionId) return scheduledSource;
				}
			}

			if (recoveryStartTime === null) break;
			iteratorStartTime = recoveryStartTime;
		}

		if (
			currentIterator &&
			this.clipIterators.get(clip.id) === currentIterator
		) {
			this.clipIterators.delete(clip.id);
		}
		// don't remove from activeClipIds - prevents scheduler from restarting this clip
		// the set is cleared on stopPlayback anyway
		return scheduledSource;
	}

	private async schedulePreparedClip({
		clip,
		startTime,
		sessionId,
	}: {
		clip: AudioClipSource;
		startTime: number;
		sessionId: number;
	}): Promise<boolean> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) return false;

		const buffer = await this.getPreparedClipBuffer({ clip });
		if (!buffer || !this.editor.playback.getIsPlaying()) return false;
		if (sessionId !== this.playbackSessionId) return false;

		const clipStart = clip.startTime;
		const clipEnd = clip.startTime + clip.duration;
		const playbackTimeAfterReady = this.getPlaybackTime();
		const effectiveStartTime = Math.max(
			startTime,
			clipStart,
			playbackTimeAfterReady,
		);
		if (effectiveStartTime >= clipEnd) {
			return false;
		}

		const node = audioContext.createBufferSource();
		node.buffer = buffer;
		const clipGain = audioContext.createGain();
		node.connect(clipGain);
		clipGain.connect(this.masterGain ?? audioContext.destination);

		const startTimestamp = this.getContextStartTime({
			audioContext,
			timelineTime: effectiveStartTime,
		});
		const clipOffset = effectiveStartTime - clipStart;
		let actualStartTimestamp = startTimestamp;
		let actualClipOffset = clipOffset;

		if (startTimestamp < audioContext.currentTime) {
			const lateOffset = audioContext.currentTime - startTimestamp;
			actualStartTimestamp = audioContext.currentTime;
			actualClipOffset = clipOffset + lateOffset;
			if (actualClipOffset >= buffer.duration) {
				return false;
			}
		}
		const sourceDuration = Math.min(
			buffer.duration - actualClipOffset,
			clipEnd - effectiveStartTime - (actualClipOffset - clipOffset),
		);
		if (sourceDuration <= 0) return false;
		node.start(actualStartTimestamp, actualClipOffset, sourceDuration);
		this.scheduledClipIds.add(clip.id);

		this.scheduleClipGainAutomation({
			audioContext,
			clip,
			clipGain,
			startTimestamp: actualStartTimestamp,
			startLocalTime: actualClipOffset,
		});

		this.queuedSources.add(node);
		node.addEventListener("ended", () => {
			node.disconnect();
			clipGain.disconnect();
			this.queuedSources.delete(node);
		});
		return true;
	}

	private waitUntilCaughtUp({
		timelineTime,
		targetAhead,
	}: {
		timelineTime: number;
		targetAhead: number;
	}): Promise<void> {
		return new Promise((resolve) => {
			const checkInterval = setInterval(() => {
				if (!this.editor.playback.getIsPlaying()) {
					clearInterval(checkInterval);
					resolve();
					return;
				}

				const playbackTime = this.getPlaybackTime();
				if (timelineTime - playbackTime < targetAhead) {
					clearInterval(checkInterval);
					resolve();
				}
			}, 100);
		});
	}

	private disposeSinks(): void {
		for (const iterator of this.clipIterators.values()) {
			void iterator.return();
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();

		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
		this.sinks.clear();
	}

	private shouldUsePreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): boolean {
		// Short clips are cheap to prepare in full and give sample-accurate
		// automation. Long clips stream from a warmed sink so Play never waits
		// for an entire podcast/video soundtrack to decode.
		return clip.duration <= 12 || clip.retime?.maintainPitch === true;
	}

	private scheduleClipGainAutomation({
		audioContext,
		clip,
		clipGain,
		startTimestamp,
		startLocalTime,
	}: {
		audioContext: AudioContext;
		clip: AudioClipSource;
		clipGain: GainNode;
		startTimestamp: number;
		startLocalTime: number;
	}): void {
		clipGain.gain.cancelScheduledValues(startTimestamp);
		clipGain.gain.setValueAtTime(clip.volume, startTimestamp);

		if (!hasVariableAudioGain({ element: clip.timelineElement })) {
			return;
		}

		const points = buildAudioGainAutomation({
			element: clip.timelineElement,
			fromLocalTime: startLocalTime,
			toLocalTime: clip.duration,
		});

		if (points.length === 0) {
			return;
		}

		clipGain.gain.setValueAtTime(points[0].gain, startTimestamp);
		for (let index = 1; index < points.length; index++) {
			const point = points[index];
			const pointTimestamp =
				startTimestamp + (point.localTime - startLocalTime);
			if (pointTimestamp < audioContext.currentTime) {
				continue;
			}

			clipGain.gain.linearRampToValueAtTime(point.gain, pointTimestamp);
		}
	}

	private buildPreparedClipCacheKey({
		clip,
	}: {
		clip: AudioClipSource;
	}): string {
		return JSON.stringify({
			id: clip.id,
			sourceKey: clip.sourceKey,
			startTime: clip.startTime,
			duration: clip.duration,
			trimStart: clip.trimStart,
			trimEnd: clip.trimEnd,
			retime: clip.retime ?? null,
		});
	}

	private async getPreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const cacheKey = this.buildPreparedClipCacheKey({ clip });
		const existing = this.preparedClipBuffers.get(cacheKey);
		if (existing) {
			return existing;
		}

		const promise = (async () => {
			const audioContext = this.ensureAudioContext();
			if (!audioContext) {
				return null;
			}

			const decodedBuffer = await this.getDecodedBuffer({ clip });
			if (!decodedBuffer) {
				return null;
			}

			return await renderRetimedBuffer({
				audioContext,
				sourceBuffer: decodedBuffer,
				trimStart: 0,
				clipDuration: clip.duration,
				retime: clip.retime,
				maintainPitch: clip.retime?.maintainPitch === true,
			});
		})();

		this.preparedClipBuffers.set(cacheKey, promise);
		void promise.then(
			(buffer) => {
				if (!buffer && this.preparedClipBuffers.get(cacheKey) === promise) {
					this.preparedClipBuffers.delete(cacheKey);
				}
			},
			() => {
				if (this.preparedClipBuffers.get(cacheKey) === promise) {
					this.preparedClipBuffers.delete(cacheKey);
				}
			},
		);
		return promise;
	}

	private async getDecodedBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const sourceStart = Math.max(0, clip.trimStart);
		const sourceDuration = Math.max(
			0.001,
			getSourceTimeAtClipTime({
				clipTime: clip.duration,
				retime: clip.retime,
			}),
		);
		const sourceEnd = sourceStart + sourceDuration;
		const cacheKey = `${clip.sourceKey}:${sourceStart.toFixed(6)}:${sourceEnd.toFixed(6)}`;
		const existing = this.decodedBuffers.get(cacheKey);
		if (existing) {
			return existing;
		}

		const promise = this.decodeClipBuffer({ clip, sourceStart, sourceEnd });
		this.decodedBuffers.set(cacheKey, promise);
		void promise.then(
			(buffer) => {
				if (!buffer && this.decodedBuffers.get(cacheKey) === promise) {
					this.decodedBuffers.delete(cacheKey);
				}
			},
			() => {
				if (this.decodedBuffers.get(cacheKey) === promise) {
					this.decodedBuffers.delete(cacheKey);
				}
			},
		);
		return promise;
	}

	private async decodeClipBuffer({
		clip,
		sourceStart,
		sourceEnd,
	}: {
		clip: AudioClipSource;
		sourceStart: number;
		sourceEnd: number;
	}): Promise<AudioBuffer | null> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) {
			return null;
		}

		const input = new Input({
			source: createMediaSource(clip),
			formats: ALL_FORMATS,
		});

		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			const chunks: WrappedAudioBuffer[] = [];

			for await (const chunk of sink.buffers(sourceStart, sourceEnd)) {
				chunks.push(chunk);
			}

			if (chunks.length === 0) {
				return null;
			}

			const targetSampleRate = audioContext.sampleRate;
			const nativeSampleRate = chunks[0].buffer.sampleRate;
			const numChannels = Math.min(2, chunks[0].buffer.numberOfChannels);
			const segments = chunks.flatMap((chunk) => {
				const startSample = Math.max(
					0,
					Math.round(
						(sourceStart - chunk.timestamp) * chunk.buffer.sampleRate,
					),
				);
				const endSample = Math.min(
					chunk.buffer.length,
					Math.round((sourceEnd - chunk.timestamp) * chunk.buffer.sampleRate),
				);
				return endSample > startSample
					? [{ buffer: chunk.buffer, startSample, endSample }]
					: [];
			});
			const totalSamples = segments.reduce(
				(total, segment) => total + segment.endSample - segment.startSample,
				0,
			);
			if (totalSamples <= 0) return null;
			const nativeChannels = Array.from(
				{ length: numChannels },
				() => new Float32Array(totalSamples),
			);

			let offset = 0;
			for (const segment of segments) {
				for (let channel = 0; channel < numChannels; channel++) {
					nativeChannels[channel].set(
						segment.buffer
							.getChannelData(
								Math.min(channel, segment.buffer.numberOfChannels - 1),
							)
							.subarray(segment.startSample, segment.endSample),
						offset,
					);
				}
				offset += segment.endSample - segment.startSample;
			}

			const outputSamples = Math.ceil(
				totalSamples * (targetSampleRate / nativeSampleRate),
			);
			const offlineContext = new OfflineAudioContext(
				numChannels,
				outputSamples,
				targetSampleRate,
			);
			const nativeBuffer = audioContext.createBuffer(
				numChannels,
				totalSamples,
				nativeSampleRate,
			);

			for (let channel = 0; channel < numChannels; channel++) {
				nativeBuffer.copyToChannel(nativeChannels[channel], channel);
			}

			const sourceNode = offlineContext.createBufferSource();
			sourceNode.buffer = nativeBuffer;
			sourceNode.connect(offlineContext.destination);
			sourceNode.start(0);

			return await offlineContext.startRendering();
		} catch (error) {
			console.warn("Failed to decode clip audio:", error);
			return null;
		} finally {
			input.dispose();
		}
	}

	private async getAudioSink({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBufferSink | null> {
		const existingSink = this.sinks.get(clip.sourceKey);
		if (existingSink) return existingSink;

		let input: Input | null = null;
		try {
			input = new Input({
				source: createMediaSource(clip),
				formats: ALL_FORMATS,
			});
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack) {
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			this.inputs.set(clip.sourceKey, input);
			this.sinks.set(clip.sourceKey, sink);
			input = null;
			return sink;
		} catch (error) {
			console.warn("Failed to initialize audio sink:", error);
			return null;
		} finally {
			input?.dispose();
		}
	}
}
