export const PODCAST_SYNC_RESOLUTION_SECONDS = 0.01;

export function mean({ values }: { values: ArrayLike<number> }): number {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i] ?? 0;
	return values.length > 0 ? total / values.length : 0;
}

export function standardDeviation({
	values,
	knownMean = mean({ values }),
}: {
	values: ArrayLike<number>;
	knownMean?: number;
}): number {
	let total = 0;
	for (let i = 0; i < values.length; i++) {
		const delta = (values[i] ?? 0) - knownMean;
		total += delta * delta;
	}
	return values.length > 0 ? Math.sqrt(total / values.length) : 0;
}

export function median({ values }: { values: ArrayLike<number> }): number {
	if (values.length === 0) return 0;
	const sorted = Array.from(values).sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] ?? 0)
		: ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function percentile({
	values,
	p,
}: {
	values: ArrayLike<number>;
	p: number;
}): number {
	if (values.length === 0) return 0;
	const sorted = Array.from(values).sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
	);
	return sorted[index] ?? 0;
}

function normalizeZeroMeanUnitVariance({
	values,
}: {
	values: Float32Array;
}): Float32Array {
	const m = mean({ values });
	const s = standardDeviation({ values, knownMean: m }) + 1e-10;
	const normalized = new Float32Array(values.length);
	for (let i = 0; i < values.length; i++) {
		normalized[i] = ((values[i] ?? 0) - m) / s;
	}
	return normalized;
}

export function crossCorrelationOffset({
	refEnvelope,
	targetEnvelope,
	windowSeconds,
	maxLagWindows,
}: {
	refEnvelope: Float32Array;
	targetEnvelope: Float32Array;
	windowSeconds: number;
	maxLagWindows: number;
}): { offsetSeconds: number; confidence: number } {
	if (refEnvelope.length < 4 || targetEnvelope.length < 4) {
		throw new Error("Audio is too short for energy-envelope alignment");
	}

	const ref = normalizeZeroMeanUnitVariance({ values: refEnvelope });
	const target = normalizeZeroMeanUnitVariance({ values: targetEnvelope });
	const refLength = ref.length;
	const targetLength = target.length;
	const lagLimit =
		maxLagWindows > 0 ? maxLagWindows : Math.max(refLength, targetLength);
	let lagStart = Math.max(-(targetLength - 1), -lagLimit);
	let lagEnd = Math.min(refLength - 1, lagLimit);

	if (lagStart > lagEnd) {
		lagStart = -(targetLength - 1);
		lagEnd = refLength - 1;
	}

	let bestLag = 0;
	let bestValue = -Infinity;
	const samples: number[] = [];

	for (let lag = lagStart; lag <= lagEnd; lag++) {
		const start = Math.max(0, lag);
		const end = Math.min(refLength, targetLength + lag);
		let total = 0;
		for (let j = start; j < end; j++) {
			total += (ref[j] ?? 0) * (target[j - lag] ?? 0);
		}
		samples.push(total);
		if (total > bestValue) {
			bestValue = total;
			bestLag = lag;
		}
	}

	const noise = standardDeviation({ values: samples }) + 1e-10;
	return {
		offsetSeconds: bestLag * windowSeconds,
		confidence: Math.min(1, Math.max(0, bestValue / (noise * 5))),
	};
}

export function detectSpeechFromEnvelope({
	envelope,
	options = {},
}: {
	envelope: Float32Array;
	options?: { minSpeechDuration?: number; mergeGap?: number };
}): Array<{ start: number; end: number }> {
	const minSpeechDuration = options.minSpeechDuration ?? 0.25;
	const mergeGap = options.mergeGap ?? 0.3;
	const floor = percentile({ values: envelope, p: 20 });
	const reference = percentile({ values: envelope, p: 95 });
	let threshold = floor + 0.18 * (reference - floor);
	if (!(threshold > 0)) threshold = reference * 0.18;

	const segments: Array<{ start: number; end: number }> = [];
	let inSpeech = false;
	let segmentStart = 0;

	for (let i = 0; i < envelope.length; i++) {
		const speaking = (envelope[i] ?? 0) >= threshold;
		if (speaking && !inSpeech) {
			inSpeech = true;
			segmentStart = i;
		} else if (!speaking && inSpeech) {
			inSpeech = false;
			segments.push({
				start: segmentStart * PODCAST_SYNC_RESOLUTION_SECONDS,
				end: i * PODCAST_SYNC_RESOLUTION_SECONDS,
			});
		}
	}

	if (inSpeech) {
		segments.push({
			start: segmentStart * PODCAST_SYNC_RESOLUTION_SECONDS,
			end: envelope.length * PODCAST_SYNC_RESOLUTION_SECONDS,
		});
	}

	return mergeCloseSegments({ segments, gap: mergeGap }).filter(
		(segment) => segment.end - segment.start >= minSpeechDuration,
	);
}

function mergeCloseSegments({
	segments,
	gap,
}: {
	segments: Array<{ start: number; end: number }>;
	gap: number;
}): Array<{ start: number; end: number }> {
	if (segments.length <= 1) return segments;
	const merged = [segments[0]];
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		const previous = merged[merged.length - 1];
		if (!segment || !previous) continue;
		if (segment.start - previous.end <= gap) {
			merged[merged.length - 1] = {
				start: previous.start,
				end: segment.end,
			};
		} else {
			merged.push(segment);
		}
	}
	return merged;
}

export function normalizeEnergyEnvelope({
	envelope,
	speechMask,
}: {
	envelope: Float32Array;
	speechMask: Uint8Array;
}): Float32Array {
	const speechValues: number[] = [];
	for (let i = 0; i < envelope.length; i++) {
		if (speechMask[i]) speechValues.push(envelope[i] ?? 0);
	}
	if (speechValues.length === 0) return envelope;

	const speechMedian = median({ values: speechValues });
	if (speechMedian < 1e-10) return envelope;

	const normalized = new Float32Array(envelope.length);
	for (let i = 0; i < envelope.length; i++) {
		normalized[i] = (envelope[i] ?? 0) / speechMedian;
	}
	return normalized;
}

export function buildActivityTimeline({
	channelIds,
	numSteps,
	channelEnergies,
}: {
	channelIds: string[];
	numSteps: number;
	channelEnergies: Record<string, Float32Array>;
}): Float32Array[] {
	const timeline = Array.from(
		{ length: numSteps },
		() => new Float32Array(channelIds.length),
	);

	for (let channelIndex = 0; channelIndex < channelIds.length; channelIndex++) {
		const envelope = channelEnergies[channelIds[channelIndex] ?? ""];
		if (!envelope) continue;
		const usable = Math.min(numSteps, envelope.length);
		for (let i = 0; i < usable; i++) {
			timeline[i]![channelIndex] = envelope[i] ?? 0;
		}
	}

	return timeline;
}

function estimateBleedCoefficients({
	timeline,
	numChannels,
}: {
	timeline: Float32Array[];
	numChannels: number;
}): Float32Array[] {
	const bleed = Array.from({ length: numChannels }, (_, i) => {
		const row = new Float32Array(numChannels);
		for (let j = 0; j < numChannels; j++) row[j] = i === j ? 0 : 0.35;
		return row;
	});

	const minSoloFrames = Math.round(2 / PODCAST_SYNC_RESOLUTION_SECONDS);
	const soloRatio = 3;

	for (
		let dominantChannel = 0;
		dominantChannel < numChannels;
		dominantChannel++
	) {
		const soloIndexes: number[] = [];
		for (let t = 0; t < timeline.length; t++) {
			const dominantEnergy = timeline[t]?.[dominantChannel] ?? 0;
			if (dominantEnergy <= 0.1) continue;

			let isSolo = true;
			for (let other = 0; other < numChannels; other++) {
				if (other === dominantChannel) continue;
				const otherEnergy = timeline[t]?.[other] ?? 0;
				if (!(otherEnergy < dominantEnergy / soloRatio || otherEnergy < 0.05)) {
					isSolo = false;
					break;
				}
			}
			if (isSolo) soloIndexes.push(t);
		}

		if (soloIndexes.length < minSoloFrames) continue;
		for (let otherChannel = 0; otherChannel < numChannels; otherChannel++) {
			if (otherChannel === dominantChannel) continue;

			const ratios: number[] = [];
			for (const index of soloIndexes) {
				const dominantValue = timeline[index]?.[dominantChannel] ?? 0;
				if (dominantValue > 0.05) {
					ratios.push((timeline[index]?.[otherChannel] ?? 0) / dominantValue);
				}
			}
			if (ratios.length >= minSoloFrames) {
				bleed[dominantChannel]![otherChannel] = median({ values: ratios });
			}
		}
	}

	return bleed;
}

function compensateBleed({
	timeline,
	bleed,
	numChannels,
}: {
	timeline: Float32Array[];
	bleed: Float32Array[];
	numChannels: number;
}): Float32Array[] {
	return timeline.map((row) => {
		const compensated = new Float32Array(numChannels);
		for (let target = 0; target < numChannels; target++) {
			let estimatedBleed = 0;
			for (let source = 0; source < numChannels; source++) {
				if (source === target) continue;
				estimatedBleed += (bleed[source]?.[target] ?? 0) * (row[source] ?? 0);
			}
			compensated[target] = Math.max(0, (row[target] ?? 0) - estimatedBleed);
		}
		return compensated;
	});
}

export function smoothEnergyTimeline({
	timeline,
	windowMs,
	numChannels,
}: {
	timeline: Float32Array[];
	windowMs: number;
	numChannels: number;
}): Float32Array[] {
	const winFrames = Math.max(
		1,
		Math.round(windowMs / 1000 / PODCAST_SYNC_RESOLUTION_SECONDS),
	);
	if (winFrames <= 1) return timeline.map((row) => row.slice());

	const output = Array.from(
		{ length: timeline.length },
		() => new Float32Array(numChannels),
	);
	const half = Math.floor(winFrames / 2);

	for (let channel = 0; channel < numChannels; channel++) {
		let total = 0;
		let low = 0;
		let high = 0;

		for (let i = 0; i < timeline.length; i++) {
			const wantedLow = Math.max(0, i - half);
			const wantedHigh = Math.min(timeline.length, i - half + winFrames);
			while (high < wantedHigh) {
				total += timeline[high]?.[channel] ?? 0;
				high++;
			}
			while (low < wantedLow) {
				total -= timeline[low]?.[channel] ?? 0;
				low++;
			}
			output[i]![channel] = total / winFrames;
		}
	}

	return output;
}

export function applyAntiBleedPipeline({
	timeline,
	numChannels,
}: {
	timeline: Float32Array[];
	numChannels: number;
}): Float32Array[] {
	const bleed = estimateBleedCoefficients({ timeline, numChannels });
	const compensated = compensateBleed({ timeline, bleed, numChannels });
	const smoothed = smoothEnergyTimeline({
		timeline: compensated,
		windowMs: 500,
		numChannels,
	});

	for (let channel = 0; channel < numChannels; channel++) {
		const active: number[] = [];
		for (let t = 0; t < smoothed.length; t++) {
			const value = smoothed[t]?.[channel] ?? 0;
			if (value > 0) active.push(value);
		}
		if (active.length === 0) continue;

		const floor = median({ values: active }) * 0.15;
		for (let t = 0; t < smoothed.length; t++) {
			if ((smoothed[t]?.[channel] ?? 0) < floor) {
				smoothed[t]![channel] = 0;
			}
		}
	}

	return smoothEnergyTimeline({
		timeline: smoothed,
		windowMs: 300,
		numChannels,
	});
}
