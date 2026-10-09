const MASTER_LIMITER_THRESHOLD_DB = -1;
const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;
const MASTER_OUTPUT_HEADROOM = 0.98;

const masteringLatencyBySampleRate = new Map<number, Promise<number>>();

export function getAudioBufferPeak({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): number {
	let peak = 0;

	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			const magnitude = Math.abs(channelData[index]);
			if (magnitude > peak) {
				peak = magnitude;
			}
		}
	}

	return peak;
}

export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();
	const outputGain = audioContext.createGain();

	limiter.threshold.value = MASTER_LIMITER_THRESHOLD_DB;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;
	outputGain.gain.value = MASTER_OUTPUT_HEADROOM;

	input.connect(limiter);
	limiter.connect(outputGain);
	outputGain.connect(destination);

	return { input };
}

/** Web Audio compressors buffer samples internally. Measure this browser's
 * delay instead of assuming a particular engine's lookahead duration. */
function getMasteringLatencySamples({ sampleRate }: { sampleRate: number }) {
	const cached = masteringLatencyBySampleRate.get(sampleRate);
	if (cached) return cached;
	const pending = (async () => {
		const context = new OfflineAudioContext(
			1,
			Math.ceil(sampleRate * 0.1),
			sampleRate,
		);
		const impulse = context.createBuffer(1, 1, sampleRate);
		impulse.getChannelData(0)[0] = 0.25;
		const source = context.createBufferSource();
		source.buffer = impulse;
		const { input } = createAudioMasteringChain({
			audioContext: context,
			destination: context.destination,
		});
		source.connect(input);
		source.start();
		const output = await context.startRendering();
		const latency = output.getChannelData(0).findIndex((sample) => sample !== 0);
		if (latency < 0) throw new Error("Could not measure audio mastering latency");
		return latency;
	})().catch((error: unknown) => {
		masteringLatencyBySampleRate.delete(sampleRate);
		throw error;
	});
	masteringLatencyBySampleRate.set(sampleRate, pending);
	return pending;
}

export async function applyAudioMasteringToBuffer({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): Promise<AudioBuffer> {
	if (getAudioBufferPeak({ audioBuffer }) <= MASTER_OUTPUT_HEADROOM) {
		return audioBuffer;
	}

	const latency = await getMasteringLatencySamples({
		sampleRate: audioBuffer.sampleRate,
	});
	const offlineContext = new OfflineAudioContext(
		audioBuffer.numberOfChannels,
		Math.max(1, audioBuffer.length + latency),
		audioBuffer.sampleRate,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = audioBuffer;

	const { input } = createAudioMasteringChain({
		audioContext: offlineContext,
		destination: offlineContext.destination,
	});
	source.connect(input);
	source.start(0);

	const renderedBuffer = await offlineContext.startRendering();
	// Render the delayed tail before removing the leading lookahead, so both
	// timeline alignment and the last audible samples survive mastering.
	const alignedBuffer = offlineContext.createBuffer(
		audioBuffer.numberOfChannels,
		audioBuffer.length,
		audioBuffer.sampleRate,
	);
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		alignedBuffer.copyToChannel(
			renderedBuffer.getChannelData(channel).subarray(latency),
			channel,
		);
	}
	clampAudioBufferPeak({
		audioBuffer: alignedBuffer,
		maxPeak: MASTER_OUTPUT_HEADROOM,
	});
	return alignedBuffer;
}

function clampAudioBufferPeak({
	audioBuffer,
	maxPeak,
}: {
	audioBuffer: AudioBuffer;
	maxPeak: number;
}): void {
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			channelData[index] = Math.max(
				-maxPeak,
				Math.min(maxPeak, channelData[index]),
			);
		}
	}
}
