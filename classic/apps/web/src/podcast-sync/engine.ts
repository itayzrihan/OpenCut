import {
	isUnifiedAnglesAsset,
	resolveUnifiedAnglesAudioAsset,
} from "@/media/unified-angles";
import type { MediaAsset } from "@/media/types";
import {
	podcastCameraClock,
	planPodcastPrecision,
	resolvePodcastPrecision,
	type PodcastPrecisionEstimate,
	type CameraSource,
	type PodcastCameraWindow,
	type PodcastMulticamSettings,
} from "opencut-wasm";

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
	/** Real cameras behind a virtual Unified Angles asset. */
	angles?: MediaAsset[];
}

export type PodcastSyncSettings = PodcastMulticamSettings;

export interface PodcastSyncAlignment {
	duration: number;
	precisionWarnings?: string[];
	videoOffsets: Record<string, number>;
	videoDelays: Record<string, number>;
	cameraWindows: PodcastCameraWindow[];
	unifiedSync: Array<{ mediaId: string; sources: CameraSource[] }>;
	bindings: Record<string, number>;
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
	videoDelays: PodcastSyncAlignment["videoDelays"];
	bindings: PodcastSyncAlignment["bindings"];
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
			channels
				.flatMap((c) => [...(c.angles ?? [c.video]), c.audio])
				.map((a) => [a.id, a]),
		).values(),
	];
	if (assets.length > 64)
		throw new Error(
			"Choose at most 64 camera and microphone sources in one synchronization job",
		);
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
		offsets: (number | undefined)[];
		confidence: number[];
		referenceIndex: number;
		parents: (number | undefined)[];
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
	report({
		onProgress,
		step: "Verifying waveform sync across the recording",
		progress: 0.88,
	});
	const precisionWindows = planPodcastPrecision({
		alignment: group,
		durations: assets.map(
			(a, i) =>
				a.duration ?? envelopes[i]!.length * PODCAST_SYNC_RESOLUTION_SECONDS,
		),
	});
	let verifiedWindows = 0;
	const estimates = await mapConcurrent({
		items: precisionWindows,
		concurrency: 2,
		signal,
		task: async (window, jobSignal) => {
			const source = (index: number) => ({
				file: assets[index]!.file,
				url: assets[index]!.url,
				name: assets[index]!.name,
			});
			const result = await runSyncWorker<PodcastPrecisionEstimate>({
				message: {
					type: "precision",
					reference: source(window.referenceIndex),
					target: source(window.targetIndex),
					window,
				},
				signal: jobSignal,
			});
			report({
				onProgress,
				step: `Verifying waveform sync (${++verifiedWindows}/${precisionWindows.length})`,
				progress: 0.88 + (0.1 * verifiedWindows) / precisionWindows.length,
			});
			return result;
		},
	});
	const precise = resolvePodcastPrecision({
		alignment: group,
		windows: precisionWindows,
		estimates,
	});
	if (precise.drifting.length)
		throw new Error(
			`Recording timing changes between sections: ${precise.drifting.map((i) => assets[i]!.name).join(", ")}. Check recorder clock drift or edited source files; automatic fixed-offset sync is not reliable.`,
		);
	if (precise.offsets.some((v) => v == null))
		throw new Error("Cannot verify a shared synchronization clock");
	const precisionWarnings = precise.unverified.map(
		(i) =>
			`Fine waveform sync could not be verified for ${assets[i]!.name}; coarse alignment retained. Check lip sync before export.`,
	);
	const offsets = new Map(assets.map((a, i) => [a.id, precise.offsets[i]!]));
	const baseVideos = channels.map((c) => {
		if (!c.angles) return c.video;
		const clock = podcastCameraClock({
			sources: c.angles.map((a) => ({
				id: a.id,
				duration: a.duration ?? 0,
				start: offsets.get(a.id)!,
				bindingRevision: a.bindingRevision ?? 0,
			})),
		});
		if (!clock) throw new Error("Camera duration is missing");
		return c.angles.find((a) => a.id === clock.referenceId)!;
	});
	const clock = podcastCameraClock({
		sources: baseVideos.map((a) => ({
			id: a.id,
			duration: a.duration ?? 0,
			start: offsets.get(a.id)!,
			bindingRevision: a.bindingRevision ?? 0,
		})),
	});
	if (!clock) throw new Error("Cannot determine the longest camera recording");
	const { origin, duration } = clock;
	const videoOffsets: Record<string, number> = {};
	const videoDelays: Record<string, number> = {};
	const audioOffsets: Record<string, number> = {};
	const audioDelays: Record<string, number> = {};
	const cameraWindows: PodcastCameraWindow[] = [];
	const unifiedSync: PodcastSyncAlignment["unifiedSync"] = [];
	for (const [index, channel] of channels.entries()) {
		const base = baseVideos[index]!;
		const sourceAtZero = origin - offsets.get(base.id)!;
		videoOffsets[channel.id] = Math.max(0, sourceAtZero);
		videoDelays[channel.id] = Math.max(0, -sourceAtZero);
		const start = Math.max(0, -sourceAtZero);
		const end = Math.min(duration, (base.duration ?? 0) - sourceAtZero);
		if (end <= start)
			throw new Error(`${channel.name} has no footage on the main recording`);
		cameraWindows.push({ channelId: channel.id, start, end });
		const audioAtZero = origin - offsets.get(channel.audio.id)!;
		audioOffsets[channel.id] = Math.max(0, audioAtZero);
		audioDelays[channel.id] = Math.max(0, -audioAtZero);
		if (channel.angles)
			unifiedSync.push({
				mediaId: channel.video.id,
				sources: channel.angles.map((a) => ({
					id: a.id,
					duration: a.duration!,
					start: offsets.get(a.id)!,
					bindingRevision: a.bindingRevision ?? 0,
				})),
			});
	}
	const bindings = Object.fromEntries(
		assets.map((a) => [a.id, a.bindingRevision ?? 0]),
	);
	report({ onProgress, step: "Synchronization complete", progress: 1 });
	const alignment = {
		precisionWarnings,
		duration,
		videoOffsets,
		videoDelays,
		cameraWindows,
		unifiedSync,
		bindings,
		audioOffsets,
		audioDelays,
	};
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
	const { duration, videoOffsets, videoDelays, audioOffsets, audioDelays } =
		alignment;

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
			cameraWindows: alignment.cameraWindows,
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
		videoDelays,
		bindings: alignment.bindings,
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

/** Resolve virtual media before any decoder is called. No virtual URLs go to audio IO. */
export function resolvePodcastChannelSources({
	channels,
	mediaAssets,
}: {
	channels: PodcastSyncChannel[];
	mediaAssets: MediaAsset[];
}): PodcastSyncChannel[] {
	const map = new Map(mediaAssets.map((a) => [a.id, a]));
	return channels.map((channel) => {
		const video = map.get(channel.video.id) ?? channel.video;
		const audioInput = map.get(channel.audio.id) ?? channel.audio;
		let audio = resolveUnifiedAnglesAudioAsset({
			asset: audioInput,
			mediaMap: map,
		});
		if (isUnifiedAnglesAsset(audioInput)) {
			const sources = audioInput.unifiedAngles.angleAssetIds
				.map((id) => map.get(id))
				.filter((a): a is MediaAsset => !!a);
			const clock = podcastCameraClock({
				sources: sources.map((a) => ({
					id: a.id,
					duration: a.duration ?? 0,
					start: 0,
					bindingRevision: a.bindingRevision ?? 0,
				})),
			});
			const longest = sources.find((a) => a.id === clock?.referenceId);
			if (longest && longest.hasAudio !== false) audio = longest;
		}
		if (!audio || audio.missing)
			throw new Error(`${channel.name}: audio source is missing`);
		const angles = isUnifiedAnglesAsset(video)
			? video.unifiedAngles.angleAssetIds.map((id) => {
					const a = map.get(id);
					if (!a || a.missing || isUnifiedAnglesAsset(a))
						throw new Error(`${channel.name}: camera source is missing`);
					return a;
				})
			: undefined;
		return { ...channel, video, audio, angles };
	});
}
