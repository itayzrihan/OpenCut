import type { FrameRate } from "opencut-wasm";
import {
	addMediaTime,
	clampMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	roundFrameTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type PlaybackProjectReader = {
	getActive: () => { settings: { fps: FrameRate } } | null | undefined;
};

type PlaybackTimelineReader = {
	getTotalDuration: () => MediaTime;
	subscribe: (listener: () => void) => () => void;
};

type PlaybackScenesReader = {
	subscribe: (listener: () => void) => () => void;
};

export type PlaybackManagerEditor = {
	project: PlaybackProjectReader;
	timeline: PlaybackTimelineReader;
	scenes: PlaybackScenesReader;
};

export interface PlaybackPreparationContext {
	time: MediaTime;
	lookaheadSeconds: number;
	signal: AbortSignal;
}

export interface PlaybackPreparer {
	id: string;
	prepare: (context: PlaybackPreparationContext) => Promise<void>;
}

const DEFAULT_PLAYBACK_PREBUFFER_SECONDS = 3;

export class PlaybackManager {
	private isPlaying = false;
	private isBuffering = false;
	private currentTime: MediaTime = ZERO_MEDIA_TIME;
	private volume = 1;
	private muted = false;
	private previousVolume = 1;
	private isScrubbing = false;
	private listeners = new Set<() => void>();
	private updateListeners = new Set<(time: MediaTime) => void>();
	private seekListeners = new Set<(time: MediaTime) => void>();
	private playbackTimer: number | null = null;
	private playbackStartWallTime = 0;
	private playbackStartTime: MediaTime = ZERO_MEDIA_TIME;
	private timelineScopeBound = false;
	private suspensionCount = 0;
	private resumeAfterSuspension = false;
	private preparationId = 0;
	private preparationAbortController: AbortController | null = null;
	private preparers = new Map<string, PlaybackPreparer["prepare"]>();

	constructor(private editor: PlaybackManagerEditor) {}

	bindTimelineScope(): void {
		if (this.timelineScopeBound) {
			return;
		}

		const reconcile = () => {
			this.handleTimelineScopeChange();
		};
		this.editor.timeline.subscribe(reconcile);
		this.editor.scenes.subscribe(reconcile);
		this.timelineScopeBound = true;
		this.reconcileTimelineScope();
	}

	play(): void {
		if (this.suspensionCount > 0) {
			return;
		}
		if (this.isPlaying || this.isBuffering) return;

		const maxTime = this.editor.timeline.getTotalDuration();
		if (maxTime <= 0) {
			return;
		}

		if (this.currentTime >= maxTime) {
			this.seek({ time: ZERO_MEDIA_TIME });
		}

		if (this.preparers.size === 0) {
			this.startPreparedPlayback();
			return;
		}

		this.isBuffering = true;
		this.notify();
		const preparationId = ++this.preparationId;
		const abortController = new AbortController();
		this.preparationAbortController = abortController;
		const context: PlaybackPreparationContext = {
			time: this.currentTime,
			lookaheadSeconds: DEFAULT_PLAYBACK_PREBUFFER_SECONDS,
			signal: abortController.signal,
		};

		void Promise.allSettled(
			[...this.preparers.values()].map((prepare) => prepare(context)),
		).then((results) => {
			if (
				abortController.signal.aborted ||
				preparationId !== this.preparationId ||
				!this.isBuffering ||
				this.suspensionCount > 0
			) {
				return;
			}
			for (const result of results) {
				if (result.status === "rejected") {
					console.warn("Playback prebuffer failed:", result.reason);
				}
			}
			this.preparationAbortController = null;
			this.startPreparedPlayback();
		});
	}

	pause(): void {
		this.cancelPreparation();
		this.isPlaying = false;
		this.isBuffering = false;
		this.stopTimer();
		this.notify();
	}

	suspend(): () => void {
		if (this.suspensionCount === 0) {
			this.resumeAfterSuspension = this.isPlaying || this.isBuffering;
		}
		this.suspensionCount++;

		if (this.isPlaying || this.isBuffering) {
			this.pause();
		} else {
			this.stopTimer();
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.suspensionCount = Math.max(0, this.suspensionCount - 1);
			if (this.suspensionCount > 0) return;

			const shouldResume = this.resumeAfterSuspension;
			this.resumeAfterSuspension = false;
			if (shouldResume) {
				this.play();
			}
		};
	}

	toggle(): void {
		if (this.isPlaying || this.isBuffering) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek({ time }: { time: MediaTime }): void {
		const shouldRestartBuffering = this.isBuffering;
		if (shouldRestartBuffering) {
			this.cancelPreparation();
			this.isBuffering = false;
		}
		this.currentTime = this.clampTimeToTimeline(time);
		if (this.isPlaying) {
			this.playbackStartWallTime = performance.now();
			this.playbackStartTime = this.currentTime;
		}
		this.notify();
		this.notifySeek(this.currentTime);
		if (shouldRestartBuffering) this.play();
	}

	setVolume({ volume }: { volume: number }): void {
		const clampedVolume = Math.max(0, Math.min(1, volume));
		this.volume = clampedVolume;
		this.muted = clampedVolume === 0;
		if (clampedVolume > 0) {
			this.previousVolume = clampedVolume;
		}
		this.notify();
	}

	mute(): void {
		if (this.volume > 0) {
			this.previousVolume = this.volume;
		}
		this.muted = true;
		this.volume = 0;
		this.notify();
	}

	unmute(): void {
		this.muted = false;
		this.volume = this.previousVolume;
		this.notify();
	}

	toggleMute(): void {
		if (this.muted) {
			this.unmute();
		} else {
			this.mute();
		}
	}

	getIsPlaying(): boolean {
		return this.isPlaying;
	}

	getIsBuffering(): boolean {
		return this.isBuffering;
	}

	registerPlaybackPreparer({ id, prepare }: PlaybackPreparer): () => void {
		this.preparers.set(id, prepare);
		return () => {
			if (this.preparers.get(id) === prepare) {
				this.preparers.delete(id);
			}
		};
	}

	getCurrentTime(): MediaTime {
		return this.currentTime;
	}

	getClockTime(): MediaTime {
		if (!this.isPlaying) {
			return this.currentTime;
		}

		const elapsedSeconds =
			(performance.now() - this.playbackStartWallTime) / 1000;
		const rawTime = addMediaTime({
			a: this.playbackStartTime,
			b: mediaTimeFromSeconds({ seconds: elapsedSeconds }),
		});
		return this.clampTimeToTimeline(rawTime);
	}

	getVolume(): number {
		return this.volume;
	}

	isMuted(): boolean {
		return this.muted;
	}

	setScrubbing({ isScrubbing }: { isScrubbing: boolean }): void {
		this.isScrubbing = isScrubbing;
		this.notify();
	}

	getIsScrubbing(): boolean {
		return this.isScrubbing;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	onUpdate(listener: (time: MediaTime) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	onSeek(listener: (time: MediaTime) => void): () => void {
		this.seekListeners.add(listener);
		return () => this.seekListeners.delete(listener);
	}

	private reconcileTimelineScope(): void {
		const maxTime = this.editor.timeline.getTotalDuration();
		const nextTime = this.clampTimeToTimeline(this.currentTime);
		const shouldPause = this.isPlaying && nextTime >= maxTime;
		const timeChanged = nextTime !== this.currentTime;

		if (!timeChanged && !shouldPause) {
			return;
		}

		if (shouldPause) {
			this.isPlaying = false;
			this.stopTimer();
		}

		this.currentTime = nextTime;
		this.notify();

		if (timeChanged) {
			this.notifySeek(this.currentTime);
			this.dispatchSeekEvent(this.currentTime);
		}
	}

	private handleTimelineScopeChange(): void {
		const shouldResume = this.isPlaying || this.isBuffering;
		if (this.isPlaying) {
			this.currentTime = this.clampTimeToTimeline(this.getClockTime());
		}
		if (shouldResume) this.pause();
		this.reconcileTimelineScope();
		if (!shouldResume || this.suspensionCount > 0) return;

		queueMicrotask(() => {
			if (!this.isPlaying && !this.isBuffering && this.suspensionCount === 0) {
				this.play();
			}
		});
	}

	private startPreparedPlayback(): void {
		this.isBuffering = false;
		this.isPlaying = true;
		this.startTimer();
		this.notify();
	}

	private cancelPreparation(): void {
		this.preparationId++;
		this.preparationAbortController?.abort();
		this.preparationAbortController = null;
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private notifyUpdate(time: MediaTime): void {
		this.updateListeners.forEach((fn) => {
			fn(time);
		});
	}

	private notifySeek(time: MediaTime): void {
		this.seekListeners.forEach((fn) => {
			fn(time);
		});
	}

	private startTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
		}

		this.playbackStartWallTime = performance.now();
		this.playbackStartTime = this.currentTime;
		this.updateTime();
	}

	private stopTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
			this.playbackTimer = null;
		}
	}

	private updateTime = (): void => {
		if (!this.isPlaying) return;

		const fps = this.editor.project.getActive()?.settings.fps;
		const rawTime = this.getClockTime();
		const newTime = fps ? roundFrameTime({ time: rawTime, fps }) : rawTime;
		const maxTime = this.editor.timeline.getTotalDuration();

		if (newTime >= maxTime) {
			this.pause();
			this.currentTime = maxTime;
			this.notify();
			this.notifySeek(maxTime);
			this.dispatchSeekEvent(maxTime);
			return;
		}

		if (newTime === this.currentTime) {
			this.playbackTimer = requestAnimationFrame(this.updateTime);
			return;
		}

		this.currentTime = newTime;
		this.notifyUpdate(newTime);
		this.dispatchUpdateEvent(newTime);
		this.playbackTimer = requestAnimationFrame(this.updateTime);
	};

	private clampTimeToTimeline(time: MediaTime): MediaTime {
		const maxTime = this.editor.timeline.getTotalDuration();
		return clampMediaTime({ time, min: ZERO_MEDIA_TIME, max: maxTime });
	}

	private dispatchSeekEvent(_time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}

	private dispatchUpdateEvent(_time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}
}
