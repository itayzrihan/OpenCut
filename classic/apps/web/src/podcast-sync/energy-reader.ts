import { readNativeSyncAudio } from "./native-audio";
import {
	ALL_FORMATS,
	AudioSampleSink,
	Input,
	type AudioSample,
} from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "@/media/source";
const PODCAST_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_WINDOWS = 3_600_000;
export async function readEnergyEnvelope({
	asset,
	windowSeconds,
	startSeconds = 0,
	durationSeconds,
	sampleMode = "rms",
	signal,
}: {
	asset: BrowserMediaSource & { name: string };
	windowSeconds: number;
	startSeconds?: number;
	durationSeconds?: number;
	sampleMode?: "rms" | "waveform";
	signal?: AbortSignal;
}): Promise<Float32Array> {
	signal?.throwIfAborted();
	const native = await readNativeSyncAudio({
		asset,
		startSeconds,
		durationSeconds,
		waveform: sampleMode === "waveform",
		signal,
	});
	signal?.throwIfAborted();
	if (native) return native;
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
		const requestedLength =
			durationSeconds == null
				? undefined
				: Math.max(1, Math.ceil(durationSeconds / windowSeconds));
		if (requestedLength != null && requestedLength > MAX_ENVELOPE_WINDOWS)
			throw new Error("Recording exceeds the synchronization limit");
		let sums = new Float32Array(requestedLength ?? 16_384);
		let counts = new Uint32Array(sums.length);
		let filled = 0;
		const endSeconds =
			durationSeconds != null
				? startSeconds + Math.max(0, durationSeconds)
				: Number.POSITIVE_INFINITY;
		let fallbackTimestamp = startSeconds;

		let firstPlane = new Float32Array(0);
		let secondPlane = new Float32Array(0);

		for await (const sample of sink.samples(startSeconds, endSeconds)) {
			try {
				signal?.throwIfAborted();
				const sampleRate = sample.sampleRate;
				const chunkTimestamp = Number.isFinite(sample.timestamp)
					? sample.timestamp
					: fallbackTimestamp;
				fallbackTimestamp = chunkTimestamp + sample.numberOfFrames / sampleRate;

				if (chunkTimestamp >= endSeconds) break;

				const firstSample = Math.max(
					0,
					Math.floor((startSeconds - chunkTimestamp) * sampleRate),
				);
				const lastSampleExclusive = Math.min(
					sample.numberOfFrames,
					Number.isFinite(endSeconds)
						? Math.ceil((endSeconds - chunkTimestamp) * sampleRate)
						: sample.numberOfFrames,
				);
				if (lastSampleExclusive <= firstSample) continue;

				const first = copyPlane({ planeIndex: 0, sample, scratch: firstPlane });
				firstPlane = first;
				const second =
					sample.numberOfChannels > 1
						? copyPlane({ planeIndex: 1, sample, scratch: secondPlane })
						: undefined;
				if (second) secondPlane = second;

				let sampleStart = firstSample;
				while (sampleStart < lastSampleExclusive) {
					const localStart = Math.max(
						0,
						chunkTimestamp + sampleStart / sampleRate - startSeconds,
					);
					const windowIndex = Math.floor(localStart / windowSeconds);
					if (windowIndex >= MAX_ENVELOPE_WINDOWS)
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
					for (let i = sampleStart; i < sampleEnd; i++) {
						const mono = second ? (first[i]! + second[i]!) * 0.5 : first[i]!;
						sum += sampleMode === "waveform" ? mono : mono * mono;
					}

					// An exact right-edge sample can round into the next bucket.
					if (requestedLength == null || windowIndex < requestedLength) {
						if (windowIndex >= sums.length) {
							const capacity = Math.min(
								MAX_ENVELOPE_WINDOWS,
								Math.max(sums.length * 2, windowIndex + 1),
							);
							const grownSums = new Float32Array(capacity);
							const grownCounts = new Uint32Array(capacity);
							grownSums.set(sums);
							grownCounts.set(counts);
							sums = grownSums;
							counts = grownCounts;
						}
						sums[windowIndex] = sums[windowIndex]! + sum;
						counts[windowIndex] =
							counts[windowIndex]! + sampleEnd - sampleStart;
						filled = Math.max(filled, windowIndex + 1);
					}
					sampleStart = sampleEnd;
				}
			} finally {
				sample.close();
			}
		}

		const expectedLength = requestedLength ?? filled;
		if (expectedLength === 0) {
			throw new Error(`${asset.name} has no decodable audio`);
		}

		const envelope = sums.subarray(0, expectedLength);
		for (let i = 0; i < expectedLength; i++) {
			const count = counts[i] ?? 0;
			const mean = count > 0 ? (sums[i] ?? 0) / count : 0;
			envelope[i] = sampleMode === "waveform" ? mean : Math.sqrt(mean);
		}
		return envelope;
	} finally {
		signal?.removeEventListener("abort", abort);
		input.dispose();
	}
}

function copyPlane({
	planeIndex,
	sample,
	scratch,
}: {
	planeIndex: number;
	sample: AudioSample;
	scratch: Float32Array<ArrayBuffer>;
}) {
	const data =
		scratch.length >= sample.numberOfFrames
			? scratch
			: new Float32Array(sample.numberOfFrames);
	sample.copyTo(data, { planeIndex, format: "f32-planar" });
	return data;
}
