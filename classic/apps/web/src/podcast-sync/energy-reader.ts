import { ALL_FORMATS, AudioSampleSink, Input } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "@/media/source";
const PODCAST_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
export async function readEnergyEnvelope({
	asset,
	windowSeconds,
	startSeconds = 0,
	durationSeconds,
	signal,
}: {
	asset: BrowserMediaSource & { name: string };
	windowSeconds: number;
	startSeconds?: number;
	durationSeconds?: number;
	signal?: AbortSignal;
}): Promise<Float32Array> {
	signal?.throwIfAborted();
	const input = new Input({
		source: createMediaSource({
			...asset,
			urlOptions: {
				maxCacheSize: PODCAST_SOURCE_CACHE_BYTES,
				parallelism: 1,
			},
		}),
		formats: ALL_FORMATS,
	});

	const abort = () => input.dispose();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			throw new Error(`${asset.name} does not contain an audio track`);
		}

		const sink = new AudioSampleSink(audioTrack);
		async function* buffers() {
			for await (const sample of sink.samples(startSeconds)) {
				try {
					const channels = Array.from(
						{ length: Math.min(2, sample.numberOfChannels) },
						(_, planeIndex) => {
							const data = new Float32Array(sample.numberOfFrames);
							sample.copyTo(data, { planeIndex, format: "f32-planar" });
							return data;
						},
					);
					yield {
						timestamp: sample.timestamp,
						buffer: {
							sampleRate: sample.sampleRate,
							length: sample.numberOfFrames,
							numberOfChannels: channels.length,
							getChannelData: (channel: number) => channels[channel]!,
						},
					};
				} finally {
					sample.close();
				}
			}
		}
		const sums: number[] = [];
		const counts: number[] = [];
		const endSeconds =
			durationSeconds != null
				? startSeconds + Math.max(0, durationSeconds)
				: Number.POSITIVE_INFINITY;
		let fallbackTimestamp = startSeconds;

		for await (const { buffer, timestamp } of buffers()) {
			signal?.throwIfAborted();
			const sampleRate = buffer.sampleRate;
			const chunkTimestamp =
				typeof timestamp === "number" && Number.isFinite(timestamp)
					? timestamp
					: fallbackTimestamp;
			fallbackTimestamp = chunkTimestamp + buffer.length / sampleRate;

			if (chunkTimestamp >= endSeconds) break;

			const firstSample = Math.max(
				0,
				Math.floor((startSeconds - chunkTimestamp) * sampleRate),
			);
			const lastSampleExclusive = Math.min(
				buffer.length,
				Number.isFinite(endSeconds)
					? Math.ceil((endSeconds - chunkTimestamp) * sampleRate)
					: buffer.length,
			);
			if (lastSampleExclusive <= firstSample) continue;

			const channelCount = Math.max(1, Math.min(2, buffer.numberOfChannels));
			const channels = Array.from({ length: channelCount }, (_, channel) =>
				buffer.getChannelData(channel),
			);

			let sampleStart = firstSample;
			while (sampleStart < lastSampleExclusive) {
				const localStart = Math.max(
					0,
					chunkTimestamp + sampleStart / sampleRate - startSeconds,
				);
				const windowIndex = Math.floor(localStart / windowSeconds);
				if (windowIndex >= 3_600_000)
					throw new Error(
						"Recording exceeds the ten-hour synchronization limit",
					);
				const windowEndSeconds =
					startSeconds + (windowIndex + 1) * windowSeconds;
				const sampleEnd = Math.min(
					lastSampleExclusive,
					Math.max(
						sampleStart + 1,
						Math.ceil((windowEndSeconds - chunkTimestamp) * sampleRate),
					),
				);

				let sum = 0;
				let count = 0;
				for (let i = sampleStart; i < sampleEnd; i++) {
					let mono = 0;
					for (const data of channels) mono += data[i] ?? 0;
					mono /= channelCount;
					sum += mono * mono;
					count++;
				}

				sums[windowIndex] = (sums[windowIndex] ?? 0) + sum;
				counts[windowIndex] = (counts[windowIndex] ?? 0) + count;
				sampleStart = sampleEnd;
			}
		}

		const expectedLength =
			durationSeconds != null
				? Math.max(1, Math.ceil(durationSeconds / windowSeconds))
				: sums.length;
		if (expectedLength === 0) {
			throw new Error(`${asset.name} has no decodable audio`);
		}

		const envelope = new Float32Array(expectedLength);
		for (let i = 0; i < expectedLength; i++) {
			const count = counts[i] ?? 0;
			envelope[i] = count > 0 ? Math.sqrt((sums[i] ?? 0) / count) : 0;
		}
		return envelope;
	} finally {
		signal?.removeEventListener("abort", abort);
		input.dispose();
	}
}
