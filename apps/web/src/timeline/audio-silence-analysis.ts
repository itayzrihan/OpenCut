import type { AudioAnalysisFrame } from "opencut-wasm";

export const DEEP_AUDIO_FRAME_SECONDS = 0.02;
export const FAST_AUDIO_FRAME_SECONDS = 0.05;

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
