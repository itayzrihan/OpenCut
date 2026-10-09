import { isRenderPerfEnabled } from "./render-perf";

const MAX_SAMPLES = 240;

type Run = {
	startedAt: number;
	fps: number;
	frames: number[];
	completedAt: number[];
	renderMs: number[];
	lagMs: number[];
	errors: number;
};

export type PreviewFrameTicket = { run: Run; startedAt: number; frame: number };

export type PreviewPlaybackReport = {
	reason: "pause" | "seek" | "window" | "dispose";
	targetFps: number;
	wallMs: number;
	completedFrames: number;
	distinctFrames: number;
	firstFrame: number | null;
	lastFrame: number | null;
	skippedFrames: number;
	completionFps: number;
	firstFrameWaitMs: number | null;
	renderMs: ReturnType<typeof summarize>;
	transportLagMs: ReturnType<typeof summarize>;
	errors: number;
};

/** Local diagnostics derived from the existing playback clock. These measure
 * completed preview renders, including native composition and source seeks;
 * they do not measure physical display refresh or change editor playback. */
export class PreviewPlaybackProbe {
	private run: Run | null = null;
	private readonly now: () => number;
	private readonly enabled: () => boolean;
	private readonly report: (report: PreviewPlaybackReport) => void;

	constructor(
		options: {
			now?: () => number;
			enabled?: () => boolean;
			report?: (report: PreviewPlaybackReport) => void;
		} = {},
	) {
		this.now = options.now ?? (() => performance.now());
		this.enabled = options.enabled ?? isRenderPerfEnabled;
		this.report =
			options.report ??
			((report) =>
				console.info(`[preview-playback] ${JSON.stringify(report)}`));
	}

	setPlaying({ playing, fps }: { playing: boolean; fps: number }): void {
		if (!playing || !this.enabled()) {
			this.stop({ reason: "pause" });
			return;
		}
		if (this.run) return;
		if (!Number.isFinite(fps) || fps <= 0) return;
		this.run = this.createRun({ fps });
	}

	restartForSeek(): void {
		const fps = this.run?.fps;
		this.stop({ reason: "seek" });
		if (fps !== undefined && this.enabled()) this.run = this.createRun({ fps });
	}

	beginFrame({ frame }: { frame: number }): PreviewFrameTicket | null {
		if (!this.run || !this.enabled()) return null;
		return { run: this.run, startedAt: this.now(), frame };
	}

	completeFrame({
		ticket,
		transportLagMs,
	}: {
		ticket: PreviewFrameTicket | null;
		transportLagMs: number;
	}): void {
		if (!ticket || ticket.run !== this.run || !this.enabled()) return;
		const run = ticket.run;
		const now = this.now();
		run.frames.push(ticket.frame);
		run.completedAt.push(now);
		run.renderMs.push(now - ticket.startedAt);
		run.lagMs.push(Math.max(0, transportLagMs));
		if (run.frames.length >= MAX_SAMPLES) {
			this.stop({ reason: "window" });
			this.run = this.createRun({ fps: run.fps });
		}
	}

	failFrame({ ticket }: { ticket: PreviewFrameTicket | null }): void {
		if (ticket && ticket.run === this.run) ticket.run.errors++;
	}

	stop({ reason }: { reason: PreviewPlaybackReport["reason"] }): void {
		const run = this.run;
		this.run = null;
		if (!run || !this.enabled() || (!run.frames.length && !run.errors)) return;
		const frames = [...new Set(run.frames)];
		const firstFrame = frames[0] ?? null;
		const lastFrame = frames.at(-1) ?? null;
		const span =
			firstFrame === null || lastFrame === null
				? 0
				: lastFrame - firstFrame + 1;
		const wallMs = this.now() - run.startedAt;
		this.report({
			reason,
			targetFps: run.fps,
			wallMs: round(wallMs),
			completedFrames: run.frames.length,
			distinctFrames: frames.length,
			firstFrame,
			lastFrame,
			skippedFrames: Math.max(0, span - frames.length),
			completionFps: wallMs > 0 ? round((frames.length * 1000) / wallMs) : 0,
			firstFrameWaitMs: run.completedAt.length
				? round(run.completedAt[0] - run.startedAt)
				: null,
			renderMs: summarize(run.renderMs),
			transportLagMs: summarize(run.lagMs),
			errors: run.errors,
		});
	}

	private createRun({ fps }: { fps: number }): Run {
		return {
			startedAt: this.now(),
			fps,
			frames: [],
			completedAt: [],
			renderMs: [],
			lagMs: [],
			errors: 0,
		};
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function summarize(values: number[]) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return {
		mean: round(values.reduce((a, b) => a + b, 0) / values.length),
		p50: round(sorted[Math.floor(sorted.length * 0.5)]),
		p95: round(
			sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
		),
		max: round(sorted[sorted.length - 1]),
	};
}

/** The capture override is available only with explicit local diagnostics. */
export function forceHyperframesCaptureForDiagnostics(): boolean {
	return (
		isRenderPerfEnabled() &&
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).get("hyperframesPreview") ===
			"capture"
	);
}
