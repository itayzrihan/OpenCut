import type { MediaAsset } from "@/media/types";
import type { PodcastMulticamSettings } from "opencut-wasm";
import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource } from "@/media/source";
import {
	applyAntiBleedPipeline,
	buildActivityTimeline,
	crossCorrelationOffset,
	detectSpeechFromEnvelope,
	normalizeEnergyEnvelope,
	PODCAST_SYNC_RESOLUTION_SECONDS,
	smoothEnergyTimeline,
} from "@/podcast-sync/dsp";
import { routePodcastSync, type PodcastSyncCut } from "@/podcast-sync/router";

const SYNC_WINDOW_SECONDS = 0.1;
const DEFAULT_MAX_LAG_SECONDS = 1200;
const PODCAST_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;

export interface PodcastSyncChannel {
	id: string;
	name: string;
	video: MediaAsset;
	audio: MediaAsset;
}

export type PodcastSyncSettings = PodcastMulticamSettings;

export interface PodcastSyncAlignment {
	duration: number;
	videoOffsets: Record<string, number>;
	audioOffsets: Record<string, number>;
	audioDelays: Record<string, number>;
}

export interface PodcastSyncResult {
	cuts: PodcastSyncCut[];
	duration: PodcastSyncAlignment["duration"];
	videoOffsets: PodcastSyncAlignment["videoOffsets"];
	audioOffsets: PodcastSyncAlignment["audioOffsets"];
	audioDelays: PodcastSyncAlignment["audioDelays"];
	summary: {
		totalCuts: number;
		perChannel: Record<string, number>;
		duration: number;
	};
}

type ProgressCallback = (progress: { step: string; progress: number }) => void;

function report({
	onProgress,
	step,
	progress,
}: {
	onProgress: ProgressCallback | undefined;
	step: string;
	progress: number;
}) {
	onProgress?.({ step, progress });
}

async function readEnergyEnvelope({
	asset,
	windowSeconds,
	startSeconds = 0,
	durationSeconds,
}: {
	asset: MediaAsset;
	windowSeconds: number;
	startSeconds?: number;
	durationSeconds?: number;
}): Promise<Float32Array> {
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

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			throw new Error(`${asset.name} does not contain an audio track`);
		}

		const sink = new AudioBufferSink(audioTrack);
		const sums: number[] = [];
		const counts: number[] = [];
		const endSeconds =
			durationSeconds != null
				? startSeconds + Math.max(0, durationSeconds)
				: Number.POSITIVE_INFINITY;
		let fallbackTimestamp = startSeconds;

		for await (const { buffer, timestamp } of sink.buffers(startSeconds)) {
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
		input.dispose();
	}
}

function buildSpeechMask({
	envelope,
	numSteps,
}: {
	envelope: Float32Array;
	numSteps: number;
}): Uint8Array {
	const speech = detectSpeechFromEnvelope({
		envelope,
		options: {
			minSpeechDuration: 0.25,
			mergeGap: 0.3,
		},
	});
	const mask = new Uint8Array(numSteps);

	for (const segment of speech) {
		const start = Math.max(
			0,
			Math.round(segment.start / PODCAST_SYNC_RESOLUTION_SECONDS),
		);
		const end = Math.min(
			numSteps,
			Math.round(segment.end / PODCAST_SYNC_RESOLUTION_SECONDS),
		);
		for (let i = start; i < end; i++) mask[i] = 1;
	}

	return mask;
}

function validatePodcastChannels({
	channels,
}: {
	channels: PodcastSyncChannel[];
}) {
	if (channels.length < 1) {
		throw new Error("Add at least one podcast channel");
	}
	for (const channel of channels) {
		if (channel.video.type !== "video") {
			throw new Error(`${channel.name} is missing a video file`);
		}
		if (channel.audio.type !== "audio" && channel.audio.type !== "video") {
			throw new Error(`${channel.name} is missing an audio source`);
		}
	}
}

export async function runPodcastAlignment({
	channels,
	settings,
	onProgress,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	onProgress?: ProgressCallback;
}): Promise<PodcastSyncAlignment> {
	validatePodcastChannels({ channels });

	const maxLagWindows = Math.round(
		(settings.maxLagSeconds || DEFAULT_MAX_LAG_SECONDS) / SYNC_WINDOW_SECONDS,
	);

	report({ onProgress, step: "Syncing cameras", progress: 0.05 });
	const cameraEnvelopes: Record<string, Float32Array> = {};
	for (let i = 0; i < channels.length; i++) {
		const channel = channels[i]!;
		cameraEnvelopes[channel.id] = await readEnergyEnvelope({
			asset: channel.video,
			windowSeconds: SYNC_WINDOW_SECONDS,
		});
		report({
			onProgress,
			step: "Syncing cameras",
			progress: 0.05 + 0.5 * ((i + 1) / channels.length),
		});
	}

	const anchor = channels[0]!;
	const cameraLag: Record<string, number> = { [anchor.id]: 0 };
	for (let i = 1; i < channels.length; i++) {
		const channel = channels[i]!;
		const result = crossCorrelationOffset({
			refEnvelope: cameraEnvelopes[anchor.id]!,
			targetEnvelope: cameraEnvelopes[channel.id]!,
			windowSeconds: SYNC_WINDOW_SECONDS,
			maxLagWindows,
		});
		cameraLag[channel.id] = result.offsetSeconds;
	}

	let maxLag = 0;
	for (const channel of channels) {
		maxLag = Math.max(maxLag, cameraLag[channel.id] ?? 0);
	}

	const videoOffsets: Record<string, number> = {};
	for (const channel of channels) {
		videoOffsets[channel.id] = Math.max(
			0,
			maxLag - (cameraLag[channel.id] ?? 0),
		);
	}

	report({ onProgress, step: "Aligning microphones", progress: 0.58 });
	const audioOffsets: Record<string, number> = {};
	const audioDelays: Record<string, number> = {};
	for (let i = 0; i < channels.length; i++) {
		const channel = channels[i]!;
		const proEnvelope = await readEnergyEnvelope({
			asset: channel.audio,
			windowSeconds: SYNC_WINDOW_SECONDS,
		});
		const result = crossCorrelationOffset({
			refEnvelope: cameraEnvelopes[channel.id]!,
			targetEnvelope: proEnvelope,
			windowSeconds: SYNC_WINDOW_SECONDS,
			maxLagWindows,
		});
		const sourceAtZero = (videoOffsets[channel.id] ?? 0) - result.offsetSeconds;
		if (sourceAtZero >= 0) {
			audioOffsets[channel.id] = sourceAtZero;
			audioDelays[channel.id] = 0;
		} else {
			audioOffsets[channel.id] = 0;
			audioDelays[channel.id] = -sourceAtZero;
		}
		report({
			onProgress,
			step: "Aligning microphones",
			progress: 0.58 + 0.37 * ((i + 1) / channels.length),
		});
	}

	let duration = Number.POSITIVE_INFINITY;
	for (const channel of channels) {
		const videoDuration = channel.video.duration ?? 0;
		duration = Math.min(
			duration,
			videoDuration - (videoOffsets[channel.id] ?? 0),
		);
	}
	if (!(duration > 0) || !Number.isFinite(duration)) {
		throw new Error(
			"Channels do not overlap after sync. Check that these files belong to the same recording.",
		);
	}
	report({ onProgress, step: "Synchronization complete", progress: 1 });
	return { duration, videoOffsets, audioOffsets, audioDelays };
}

export async function runPodcastMulticam({
	channels,
	settings,
	alignment,
	onProgress,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	alignment: PodcastSyncAlignment;
	onProgress?: ProgressCallback;
}): Promise<PodcastSyncResult> {
	validatePodcastChannels({ channels });
	const { duration, videoOffsets, audioOffsets, audioDelays } = alignment;

	const numSteps = Math.max(
		1,
		Math.round(duration / PODCAST_SYNC_RESOLUTION_SECONDS) + 1,
	);
	const channelIds = channels.map((channel) => channel.id);
	const channelEnergies: Record<string, Float32Array> = {};

	report({ onProgress, step: "Analyzing speech", progress: 0.05 });
	for (let i = 0; i < channels.length; i++) {
		const channel = channels[i]!;
		const delay = audioDelays[channel.id] ?? 0;
		const startSeconds = delay > 0 ? 0 : (audioOffsets[channel.id] ?? 0);
		const decodeDuration = Math.max(0, duration - delay);
		const envelope = await readEnergyEnvelope({
			asset: channel.audio,
			windowSeconds: PODCAST_SYNC_RESOLUTION_SECONDS,
			startSeconds,
			durationSeconds: decodeDuration,
		});

		const padded = new Float32Array(numSteps);
		const padFrames = Math.round(delay / PODCAST_SYNC_RESOLUTION_SECONDS);
		for (let frame = 0; frame < envelope.length; frame++) {
			const target = frame + padFrames;
			if (target >= numSteps) break;
			padded[target] = envelope[frame] ?? 0;
		}

		const speechMask = buildSpeechMask({ envelope: padded, numSteps });
		const normalized = normalizeEnergyEnvelope({
			envelope: padded,
			speechMask,
		});
		const masked = new Float32Array(numSteps);
		for (let frame = 0; frame < numSteps; frame++) {
			masked[frame] = speechMask[frame] ? (normalized[frame] ?? 0) : 0;
		}
		channelEnergies[channel.id] = masked;
		report({
			onProgress,
			step: "Analyzing speech",
			progress: 0.05 + 0.72 * ((i + 1) / channels.length),
		});
	}

	report({ onProgress, step: "Routing cameras", progress: 0.84 });
	let timeline = buildActivityTimeline({
		channelIds,
		numSteps,
		channelEnergies,
	});
	if (channelIds.length >= 2) {
		timeline = settings.antiBleed
			? applyAntiBleedPipeline({ timeline, numChannels: channelIds.length })
			: smoothEnergyTimeline({
					timeline,
					windowMs: 300,
					numChannels: channelIds.length,
				});
	}

	const cuts = routePodcastSync({
		timeline,
		channelIds,
		duration,
		settings,
	});

	const perChannel: Record<string, number> = {};
	for (const cut of cuts) {
		perChannel[cut.channelId] = (perChannel[cut.channelId] ?? 0) + 1;
	}

	report({ onProgress, step: "Building sequence", progress: 1 });
	return {
		cuts,
		duration,
		videoOffsets,
		audioOffsets,
		audioDelays,
		summary: {
			totalCuts: cuts.length,
			perChannel,
			duration,
		},
	};
}

export async function runPodcastSync({
	channels,
	settings,
	onProgress,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	onProgress?: ProgressCallback;
}): Promise<PodcastSyncResult> {
	const alignment = await runPodcastAlignment({
		channels,
		settings,
		onProgress: ({ step, progress }) =>
			onProgress?.({ step, progress: progress * 0.45 }),
	});
	return runPodcastMulticam({
		channels,
		settings,
		alignment,
		onProgress: ({ step, progress }) =>
			onProgress?.({ step, progress: 0.45 + progress * 0.55 }),
	});
}
