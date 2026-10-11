import {
	resolveEffectiveAudioGain,
	hasVariableAudioGain,
	buildAudioGainAutomation,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import type { RetimeConfig } from "@/timeline";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";

// Host IO windows, shared by playback and export. The Rust speech denoiser runs
// off the UI thread. Warmup is decoded before a seek/window, never added to its
// duration; the dry and wet signals remain aligned.
export const NOISE_REDUCTION_WINDOW_SECONDS = 2;
const WARMUP_SECONDS = 0.25;
let worker: Worker | undefined;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const jobs = new Map<
	number,
	{
		resolve: (channels: Float32Array[]) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
		cleanup: () => void;
	}
>();
function stopWorker(error: Error) {
	worker?.terminate();
	worker = undefined;
	for (const job of jobs.values()) {
		clearTimeout(job.timer);
		job.cleanup();
		job.reject(error);
	}
	jobs.clear();
}
function processChannels({
	channels,
	sampleRate,
	amount,
	dynamics,
	signal,
}: {
	signal?: AbortSignal;
	channels: Float32Array[];
	sampleRate: number;
	amount: number;
	dynamics?: {
		ceilingDb: number;
		lookAheadMs: number;
		releaseMs: number;
		gain: number;
		gains?: Array<{ localTime: number; gain: number }>;
		start: number;
	};
}): Promise<Float32Array[]> {
	signal?.throwIfAborted();
	if (idleTimer) clearTimeout(idleTimer);
	if (!worker) {
		worker = new Worker(
			new URL("./noise-reduction.worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.onmessage = (
			event: MessageEvent<{
				id: number;
				channels?: Float32Array[];
				error?: string;
			}>,
		) => {
			const job = jobs.get(event.data.id);
			if (job) {
				clearTimeout(job.timer);
				job.cleanup();
			}
			jobs.delete(event.data.id);
			if (event.data.channels) job?.resolve(event.data.channels);
			else job?.reject(new Error(event.data.error ?? "Noise reduction failed"));
			if (jobs.size === 0)
				idleTimer = setTimeout(
					() => stopWorker(new Error("Noise reduction worker idle")),
					30_000,
				);
		};
		worker.onerror = (event) =>
			stopWorker(new Error(event.message || "Noise reduction worker failed"));
	}
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(
			() => stopWorker(new Error("Noise reduction timed out. Try Play again.")),
			30_000,
		);
		const abort = () => {
			clearTimeout(timer);
			jobs.delete(id);
			cleanup();
			reject(new DOMException("Noise reduction cancelled", "AbortError"));
			if (jobs.size === 0) stopWorker(new Error("Noise reduction cancelled"));
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);
		jobs.set(id, { resolve, reject, timer, cleanup });
		signal?.addEventListener("abort", abort, { once: true });
		try {
			worker!.postMessage(
				{ id, channels, sampleRate, amount, dynamics },
				channels.map((channel) => channel.buffer),
			);
		} catch (error) {
			clearTimeout(timer);
			cleanup();
			jobs.delete(id);
			reject(error);
		}
	});
}

export function noiseReductionAmount(params: Record<string, unknown>): number {
	return typeof params.noiseReduction === "number" &&
		Number.isFinite(params.noiseReduction)
		? Math.max(0, Math.min(100, params.noiseReduction))
		: 0;
}

export function hasAudioProcessing(params: Record<string, unknown>): boolean {
	return noiseReductionAmount(params) > 0 || params.hardLimiterEnabled === true;
}

export async function renderNoiseReducedWindow({
	audioContext,
	clip,
	offset,
	duration,
	amount,
	readSource,
	signal,
}: {
	audioContext: BaseAudioContext;
	signal?: AbortSignal;
	clip: {
		trimStart: number;
		duration: number;
		retime?: RetimeConfig;
		timelineElement?: AudioCapableElement;
	};
	offset: number;
	duration: number;
	amount: number;
	readSource: (
		start: number,
		end: number,
	) => Promise<{ buffer: AudioBuffer; trimStart: number } | null>;
}): Promise<AudioBuffer | null> {
	signal?.throwIfAborted();
	const element = clip.timelineElement;
	const limiting = element?.params.hardLimiterEnabled === true;
	const lookAheadMs = Number(element?.params.hardLimiterLookAheadMs ?? 7);
	const start = Math.max(0, offset - (limiting ? 1.5 : WARMUP_SECONDS));
	const end = Math.min(
		clip.duration,
		offset + duration + (limiting ? lookAheadMs / 1000 + 0.001 : 0),
	);
	const sourceStart =
		clip.trimStart +
		getSourceTimeAtClipTime({ clipTime: start, retime: clip.retime });
	const sourceEnd =
		clip.trimStart +
		getSourceTimeAtClipTime({ clipTime: end, retime: clip.retime });
	const decoded = await readSource(sourceStart, sourceEnd);
	signal?.throwIfAborted();
	if (!decoded) return null;
	const rendered = await renderRetimedBuffer({
		audioContext,
		sourceBuffer: decoded.buffer,
		trimStart: decoded.trimStart,
		clipDuration: end - start,
		retime: clip.retime,
		maintainPitch: clip.retime?.maintainPitch === true,
	});
	let dynamics;
	if (limiting && element) {
		// Existing canonical gain/fade evaluation is sampled only for animated clips.
		// Constant podcast gain has no per-sample main-thread work.
		dynamics = {
			ceilingDb: Number(element.params.hardLimiterCeilingDb ?? -1),
			lookAheadMs,
			releaseMs: Number(element.params.hardLimiterReleaseMs ?? 100),
			gain: resolveEffectiveAudioGain({ element, localTime: start }),
			start,
			gains: hasVariableAudioGain({ element })
				? buildAudioGainAutomation({
						element,
						fromLocalTime: start,
						toLocalTime: end,
					})
				: undefined,
		};
	}
	const channels = await processChannels({
		channels: Array.from({ length: rendered.numberOfChannels }, (_, channel) =>
			rendered.getChannelData(channel).slice(),
		),
		sampleRate: rendered.sampleRate,
		amount,
		dynamics,
		signal,
	});
	const result = audioContext.createBuffer(
		rendered.numberOfChannels,
		Math.max(1, Math.round(duration * rendered.sampleRate)),
		rendered.sampleRate,
	);
	const firstSample = Math.round((offset - start) * rendered.sampleRate);
	for (let channel = 0; channel < channels.length; channel++)
		result.copyToChannel(
			channels[channel].slice(firstSample, firstSample + result.length),
			channel,
		);
	return result;
}
