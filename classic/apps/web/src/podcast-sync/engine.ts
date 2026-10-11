import type { MediaAsset } from "@/media/types";
import { type PodcastMulticamSettings } from "opencut-wasm";

import { readEnergyEnvelope } from "./energy-reader";
import { mapConcurrent, runSyncWorker } from "./sync-jobs";
import type { PodcastSyncCut } from "@/podcast-sync/router";
const PODCAST_SYNC_RESOLUTION_SECONDS = 0.01;

const DEFAULT_MAX_LAG_SECONDS = 1200;

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

// Ephemeral analysis cache, never editor state. Released with its alignment result.
const alignmentEnvelopes = new WeakMap<
	PodcastSyncAlignment,
	Map<string, Float32Array>
>();

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

function validatePodcastChannels({
	channels,
}: {
	channels: PodcastSyncChannel[];
}) {
	if (channels.length < 1 || channels.length > 32) {
		throw new Error("Choose between 1 and 32 podcast channels");
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
	signal,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
}): Promise<PodcastSyncAlignment> {
	signal?.throwIfAborted();
	validatePodcastChannels({ channels });

	// One job and one clock for all unique camera/microphone sources. Decode
	// each asset once; bounded Workers keep IO and sample processing off the UI.
	const assets = [
		...new Map(
			channels.flatMap((c) => [c.video, c.audio]).map((a) => [a.id, a]),
		).values(),
	];
	let completed = 0;
	report({
		onProgress,
		step: `Reading all sources (0/${assets.length})`,
		progress: 0.02,
	});
	const envelopes = await mapConcurrent({
		items: assets,
		concurrency: Math.min(
			4,
			Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
		),
		task: async (asset, jobSignal) => {
			const envelope = await runSyncWorker<Float32Array>({
				message: {
					type: "read",
					asset: { file: asset.file, url: asset.url, name: asset.name },
				},
				signal: jobSignal,
			});
			completed++;
			report({
				onProgress,
				step: `Reading all sources (${completed}/${assets.length})`,
				progress: 0.02 + (0.78 * completed) / assets.length,
			});
			return envelope;
		},
		signal,
	});
	if (envelopes.reduce((sum, e) => sum + e.length, 0) > 32_000_000) {
		throw new Error(
			"Combined recordings exceed the synchronization memory limit. Use shorter recordings or fewer sources.",
		);
	}
	report({
		onProgress,
		step: "Synchronizing all sources on one timeline",
		progress: 0.82,
	});
	const group = await runSyncWorker<{
		offsets: (number | null)[];
		confidence: number[];
		referenceIndex: number;
	}>({
		message: {
			type: "align",
			envelopes,
			maxLagSeconds: settings.maxLagSeconds || DEFAULT_MAX_LAG_SECONDS,
		},
		signal,
	});
	const missing = assets.filter((_, i) => group.offsets[i] == null);
	if (missing.length)
		throw new Error(
			`Cannot reliably synchronize: ${missing.map((a) => a.name).join(", ")}. Check recording overlap and audible reference sound.`,
		);
	const offsets = new Map(assets.map((a, i) => [a.id, group.offsets[i]!]));
	const origin = Math.max(...channels.map((c) => offsets.get(c.video.id)!));
	const videoOffsets: Record<string, number> = {};
	const audioOffsets: Record<string, number> = {};
	const audioDelays: Record<string, number> = {};
	for (const channel of channels) {
		videoOffsets[channel.id] = Math.max(
			0,
			origin - offsets.get(channel.video.id)!,
		);
		const sourceAtZero = origin - offsets.get(channel.audio.id)!;
		audioOffsets[channel.id] = Math.max(0, sourceAtZero);
		audioDelays[channel.id] = Math.max(0, -sourceAtZero);
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
	const alignment = { duration, videoOffsets, audioOffsets, audioDelays };
	alignmentEnvelopes.set(
		alignment,
		new Map(assets.map((a, i) => [a.id, envelopes[i]!])),
	);
	return alignment;
}

export async function runPodcastMulticam({
	channels,
	settings,
	alignment,
	onProgress,
	signal,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	alignment: PodcastSyncAlignment;
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
}): Promise<PodcastSyncResult> {
	signal?.throwIfAborted();
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
		const cached = alignmentEnvelopes.get(alignment)?.get(channel.audio.id);
		const envelope = cached
			? cached.subarray(
					Math.round(startSeconds / PODCAST_SYNC_RESOLUTION_SECONDS),
					Math.round(
						(startSeconds + decodeDuration) / PODCAST_SYNC_RESOLUTION_SECONDS,
					),
				)
			: await readEnergyEnvelope({
					asset: channel.audio,
					windowSeconds: PODCAST_SYNC_RESOLUTION_SECONDS,
					startSeconds,
					durationSeconds: decodeDuration,
					signal,
				});

		const padded = new Float32Array(numSteps);
		const padFrames = Math.round(delay / PODCAST_SYNC_RESOLUTION_SECONDS);
		for (let frame = 0; frame < envelope.length; frame++) {
			const target = frame + padFrames;
			if (target >= numSteps) break;
			padded[target] = envelope[frame] ?? 0;
		}

		channelEnergies[channel.id] = padded;
		report({
			onProgress,
			step: "Analyzing speech",
			progress: 0.05 + 0.72 * ((i + 1) / channels.length),
		});
	}

	report({ onProgress, step: "Routing cameras", progress: 0.84 });
	signal?.throwIfAborted();
	const cuts = await runSyncWorker<PodcastSyncCut[]>({
		message: {
			type: "route",
			envelopes: channelIds.map((id) => channelEnergies[id]!),
			channelIds,
			duration,
			settings,
		},
		signal,
	});
	if (cuts.length === 0)
		throw new Error(
			"No valid multicam plan could be produced from these microphones.",
		);

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
	signal,
}: {
	channels: PodcastSyncChannel[];
	settings: PodcastSyncSettings;
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
}): Promise<PodcastSyncResult> {
	const alignment = await runPodcastAlignment({
		channels,
		settings,
		signal,
		onProgress: ({ step, progress }) =>
			onProgress?.({ step, progress: progress * 0.45 }),
	});
	return runPodcastMulticam({
		channels,
		settings,
		alignment,
		signal,
		onProgress: ({ step, progress }) =>
			onProgress?.({ step, progress: 0.45 + progress * 0.55 }),
	});
}
