import { localizeClientMessage } from "@/i18n/client-messages";
import type { MediaAsset } from "@/media/types";
import {
	planPodcastPrecision,
	resolvePodcastPrecision,
	type PodcastGroupAlignment,
	type PodcastPrecisionEstimate,
} from "opencut-wasm";
import {
	mapConcurrent,
	readSyncEnvelope,
	runSyncWorker,
	syncReadConcurrency,
} from "./sync-jobs";

const PROBE_SECONDS = 20;
const MIN_CAMERA_SECONDS = 180;
const MIN_REFERENCE_SECONDS = 1800;
const ENVELOPE_RATE = 100;

function mediaSource({ file, url, name }: MediaAsset) {
	return { file, url, name };
}

export async function tryLongTimelineSync({
	reference,
	videos,
	signal,
	onProgress,
}: {
	reference: MediaAsset;
	videos: MediaAsset[];
	signal: AbortSignal;
	onProgress: (message: string) => void;
}): Promise<number[] | null> {
	const referenceDuration = reference.duration!;
	if (
		referenceDuration < MIN_REFERENCE_SECONDS &&
		videos.every((video) => video.duration! < MIN_CAMERA_SECONDS)
	)
		return null;

	try {
		const master = await readSyncEnvelope({
			asset: mediaSource(reference),
			signal,
			read:
				referenceDuration >= MIN_REFERENCE_SECONDS
					? readReferenceRanges
					: undefined,
		});
		let complete = 0;
		const reportProbes = () =>
			onProgress(
				localizeClientMessage("Sampling camera audio ({v0}/{v1})…", {
					v0: String(complete),
					v1: String(videos.length),
				}),
			);
		reportProbes();
		const candidates = await mapConcurrent({
			items: videos,
			concurrency: syncReadConcurrency(),
			signal,
			task: async (video, taskSignal) => {
				const duration = video.duration!;
				try {
					if (duration < MIN_CAMERA_SECONDS) {
						return [
							{
								startSeconds: 0,
								samples: await readSyncEnvelope({
									asset: mediaSource(video),
									signal: taskSignal,
								}),
							},
						];
					}
					const probes = [];
					for (const fraction of [0.15, 0.4, 0.65]) {
						const startSeconds =
							Math.round(duration * fraction * ENVELOPE_RATE) / ENVELOPE_RATE;
						const samples = await readRange({
							asset: video,
							startSeconds,
							durationSeconds: PROBE_SECONDS,
							signal: taskSignal,
						});
						probes.push({ startSeconds, samples });
					}
					return probes;
				} catch {
					taskSignal.throwIfAborted();
					return [];
				} finally {
					if (!taskSignal.aborted) {
						complete++;
						reportProbes();
					}
				}
			},
		});
		const indices = videos.map((_, index) => index);
		const offsets = await match(candidates);
		const missing = indices.filter((index) => offsets[index] == null);
		if (missing.length) {
			const retried = await readAndMatchFull(missing);
			missing.forEach((index, slot) => {
				offsets[index] = retried[slot]!;
			});
		}
		const verified = await verify({ indices, offsets });
		const drifting = indices.filter(
			(index) =>
				offsets[index] != null &&
				verified[index] == null &&
				!missing.includes(index) &&
				candidates[index]!.length > 1,
		);
		if (drifting.length) {
			const retried = await verify({
				indices: drifting,
				offsets: await readAndMatchFull(drifting),
			});
			for (const index of drifting) verified[index] = retried[index];
		}
		return verified.every((offset) => offset != null) ? verified : null;

		async function readAndMatchFull(indices: number[]) {
			onProgress(
				localizeClientMessage(
					"Reading full audio for {v0} remaining cameras…",
					{ v0: String(indices.length) },
				),
			);
			const full = await mapConcurrent({
				items: indices,
				concurrency: syncReadConcurrency(),
				signal,
				task: async (index, taskSignal) => [
					{
						startSeconds: 0,
						samples: await readSyncEnvelope({
							asset: mediaSource(videos[index]!),
							signal: taskSignal,
						}),
					},
				],
			});
			return match(full);
		}

		function match(probes: typeof candidates) {
			onProgress(
				localizeClientMessage("Matching sampled audio to the reference…"),
			);
			return runSyncWorker<Array<number | null>>({
				message: {
					type: "probe-offsets",
					reference: master,
					probes,
					maxLagSeconds: Math.max(
						referenceDuration,
						...videos.map((video) => video.duration!),
					),
				},
				signal,
			});
		}

		async function verify({
			indices,
			offsets,
		}: {
			indices: number[];
			offsets: Array<number | null>;
		}) {
			const matched = indices.filter((_, slot) => offsets[slot] != null);
			const verified: Array<number | undefined> = Array.from({
				length: videos.length,
			});
			if (matched.length === 0) return verified;
			const group: PodcastGroupAlignment = {
				offsets: [
					0,
					...offsets.filter((offset): offset is number => offset != null),
				],
				confidence: [1, ...matched.map(() => 0.65)],
				parents: [undefined, ...matched.map(() => 0)],
				referenceIndex: 0,
			};
			onProgress(
				localizeClientMessage("Verifying audio matches across the recordings…"),
			);
			const result = await verifyTimelineGroup({
				alignment: group,
				assets: [reference, ...matched.map((index) => videos[index]!)],
				signal,
			});
			matched.forEach((index, slot) => {
				const target = slot + 1;
				if (result.drifting.includes(target)) return;
				verified[index] = result.offsets[target];
			});
			return verified;
		}
	} catch {
		signal.throwIfAborted();
		return null;
	}

	async function readReferenceRanges() {
		const frames = Math.ceil(referenceDuration * ENVELOPE_RATE);
		const count = syncReadConcurrency() * 2;
		let complete = 0;
		const report = () =>
			onProgress(
				localizeClientMessage("Reading reference audio ({v0}/{v1} sections)…", {
					v0: String(complete),
					v1: String(count),
				}),
			);
		report();
		const ranges = await mapConcurrent({
			items: Array.from({ length: count }, (_, index) => index),
			concurrency: syncReadConcurrency(),
			signal,
			task: async (index, taskSignal) => {
				const start = Math.floor((frames * index) / count);
				const end = Math.floor((frames * (index + 1)) / count);
				const samples = await readRange({
					asset: reference,
					preferPcm: true,
					startSeconds: start / ENVELOPE_RATE,
					durationSeconds: (end - start) / ENVELOPE_RATE,
					signal: taskSignal,
				});
				complete++;
				report();
				return { start, length: end - start, samples };
			},
		});
		const result = new Float32Array(frames);
		for (const { start, length, samples } of ranges) {
			result.set(samples.subarray(0, length), start);
		}
		return result;
	}
}

export async function verifyTimelineGroup({
	alignment,
	assets,
	signal,
}: {
	alignment: PodcastGroupAlignment;
	assets: MediaAsset[];
	signal: AbortSignal;
}) {
	const windows = planPodcastPrecision({
		alignment,
		durations: assets.map((asset) => asset.duration!),
	});
	const estimates = await mapConcurrent({
		items: windows,
		concurrency: 2,
		signal,
		task: (window, taskSignal) =>
			runSyncWorker<PodcastPrecisionEstimate>({
				message: {
					type: "precision",
					reference: mediaSource(assets[window.referenceIndex]!),
					target: mediaSource(assets[window.targetIndex]!),
					window,
				},
				signal: taskSignal,
			}),
	});
	return resolvePodcastPrecision({ alignment, windows, estimates });
}

function readRange({
	asset,
	startSeconds,
	durationSeconds,
	signal,
	preferPcm,
}: {
	asset: MediaAsset;
	preferPcm?: boolean;
	startSeconds: number;
	durationSeconds: number;
	signal: AbortSignal;
}) {
	return runSyncWorker<Float32Array>({
		message: {
			type: "read",
			asset: mediaSource(asset),
			preferPcm,
			range: { startSeconds, durationSeconds },
		},
		signal,
	});
}
