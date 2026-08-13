export interface TimedAudioChunkLayoutInput {
	timestampSeconds: number;
	durationSeconds: number;
	sampleLength: number;
}

export interface AudioChunkPlacement {
	chunkIndex: number;
	sourceStartSample: number;
	outputStartSample: number;
	sampleCount: number;
}

export function layoutTimedAudioChunks({
	chunks,
	sampleRate,
	minimumDurationSeconds = 0,
}: {
	chunks: readonly TimedAudioChunkLayoutInput[];
	sampleRate: number;
	minimumDurationSeconds?: number;
}): {
	totalSamples: number;
	placements: AudioChunkPlacement[];
} {
	const safeSampleRate = Math.max(1, sampleRate);
	const latestChunkEnd = chunks.reduce((latest, chunk) => {
		if (!Number.isFinite(chunk.timestampSeconds)) return latest;
		const decodedDuration = Math.max(0, chunk.sampleLength) / safeSampleRate;
		const duration = Number.isFinite(chunk.durationSeconds)
			? Math.max(decodedDuration, chunk.durationSeconds)
			: decodedDuration;
		return Math.max(latest, chunk.timestampSeconds + duration);
	}, 0);
	const totalSamples = Math.max(
		1,
		Math.ceil(
			Math.max(0, minimumDurationSeconds, latestChunkEnd) * safeSampleRate,
		),
	);
	const placements = chunks.flatMap((chunk, chunkIndex) => {
		if (!Number.isFinite(chunk.timestampSeconds) || chunk.sampleLength <= 0) {
			return [];
		}

		const signedOutputStart = Math.round(
			chunk.timestampSeconds * safeSampleRate,
		);
		const sourceStartSample = Math.max(0, -signedOutputStart);
		const outputStartSample = Math.max(0, signedOutputStart);
		const sampleCount = Math.min(
			chunk.sampleLength - sourceStartSample,
			totalSamples - outputStartSample,
		);

		return sampleCount > 0
			? [
					{
						chunkIndex,
						sourceStartSample,
						outputStartSample,
						sampleCount,
					},
				]
			: [];
	});

	return { totalSamples, placements };
}
