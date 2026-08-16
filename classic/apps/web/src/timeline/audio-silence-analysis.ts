import type { AudioAnalysisFrame } from "opencut-wasm";

export const DEEP_AUDIO_FRAME_SECONDS = 0.02;
export const FAST_AUDIO_FRAME_SECONDS = 0.05;
export const AUDIO_BASED_AUDIO_FRAME_SECONDS = 0.01;
export const DEFAULT_AUDIO_MIN_SILENCE_SECONDS = 0.3;
export const MIN_AUDIO_MIN_SILENCE_SECONDS = 0.01;
export const MAX_AUDIO_MIN_SILENCE_SECONDS = 60;

export function clampAudioMinSilenceSeconds(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_AUDIO_MIN_SILENCE_SECONDS;
	return Math.min(
		MAX_AUDIO_MIN_SILENCE_SECONDS,
		Math.max(MIN_AUDIO_MIN_SILENCE_SECONDS, value),
	);
}

export const AUDIO_BASED_SILENCE_ANALYSIS_SETTINGS = {
	minSilenceSeconds: DEFAULT_AUDIO_MIN_SILENCE_SECONDS,
	minSpeechSeconds: 0.04,
	speechPaddingSeconds: 0,
	bridgeGapSeconds: 0.04,
	noisePercentile: 0.2,
	minThreshold: 0.0045,
	maxThreshold: 0.08,
	hysteresisRatio: 0.72,
	maxWordSnapSeconds: 0.22,
	minWordDurationSeconds: 0.06,
} as const;

const DEFAULT_YIELD_EVERY_FRAMES = 400;

/**
 * Converts decoded source audio into compact, clip-local features. Decoding and
 * sampling are platform concerns; speech/silence decisions remain in Rust.
 */
export async function extractCompactAudioFeatures({
	samples,
	sampleRate,
	sourceStartSeconds,
	sourceEndSeconds,
	playbackRate,
	frameDurationSeconds = DEEP_AUDIO_FRAME_SECONDS,
	yieldEveryFrames = DEFAULT_YIELD_EVERY_FRAMES,
	yieldControl = yieldToBrowser,
}: {
	samples: Float32Array;
	sampleRate: number;
	sourceStartSeconds: number;
	sourceEndSeconds: number;
	playbackRate: number;
	frameDurationSeconds?: number;
	yieldEveryFrames?: number;
	yieldControl?: () => Promise<void>;
}): Promise<AudioAnalysisFrame[]> {
	if (
		!Number.isFinite(sampleRate) ||
		sampleRate <= 0 ||
		!Number.isFinite(sourceStartSeconds) ||
		!Number.isFinite(sourceEndSeconds) ||
		sourceEndSeconds <= sourceStartSeconds ||
		!Number.isFinite(playbackRate) ||
		playbackRate <= 0 ||
		!Number.isFinite(frameDurationSeconds) ||
		frameDurationSeconds <= 0 ||
		samples.length === 0
	) {
		return [];
	}

	const firstSample = Math.max(
		0,
		Math.min(samples.length, Math.floor(sourceStartSeconds * sampleRate)),
	);
	const finalSample = Math.max(
		firstSample,
		Math.min(samples.length, Math.ceil(sourceEndSeconds * sampleRate)),
	);
	const frameSize = Math.max(1, Math.round(sampleRate * frameDurationSeconds));
	const frames: AudioAnalysisFrame[] = [];
	let frameIndex = 0;

	for (
		let frameStartSample = firstSample;
		frameStartSample < finalSample;
		frameStartSample += frameSize
	) {
		const frameEndSample = Math.min(finalSample, frameStartSample + frameSize);
		let sumSquares = 0;
		let peak = 0;
		let zeroCrossings = 0;
		let previous = samples[frameStartSample] ?? 0;
		for (
			let sampleIndex = frameStartSample;
			sampleIndex < frameEndSample;
			sampleIndex += 1
		) {
			const sample = samples[sampleIndex] ?? 0;
			sumSquares += sample * sample;
			peak = Math.max(peak, Math.abs(sample));
			if (
				sampleIndex > frameStartSample &&
				((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0))
			) {
				zeroCrossings += 1;
			}
			previous = sample;
		}

		const sampleCount = Math.max(1, frameEndSample - frameStartSample);
		const sourceFrameStart = frameStartSample / sampleRate;
		const sourceFrameEnd = frameEndSample / sampleRate;
		frames.push({
			start: Math.max(
				0,
				(sourceFrameStart - sourceStartSeconds) / playbackRate,
			),
			end: Math.max(0, (sourceFrameEnd - sourceStartSeconds) / playbackRate),
			rms: Math.sqrt(sumSquares / sampleCount),
			peak,
			zeroCrossingRate: sampleCount > 1 ? zeroCrossings / (sampleCount - 1) : 0,
		});

		frameIndex += 1;
		if (
			yieldEveryFrames > 0 &&
			frameIndex % yieldEveryFrames === 0 &&
			frameEndSample < finalSample
		) {
			await yieldControl();
		}
	}

	return frames;
}

async function yieldToBrowser(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
}
