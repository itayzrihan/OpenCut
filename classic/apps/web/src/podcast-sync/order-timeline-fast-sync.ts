import { guideTimelineSync } from "./guided-sync";
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

const MIN_CAMERA_SECONDS = 180;
const MIN_REFERENCE_SECONDS = 1800;
const ENVELOPE_RATE = 100;

function mediaSource({ file, url, name }: MediaAsset) {
	return { file, url, name };
}

export async function tryLongTimelineSync({
	reference,
	videos: cameras,
	known,
	signal,
	onProgress,
}: {
	reference: MediaAsset;
	videos: Array<{ asset: MediaAsset; angle: number }>;
	known: ReadonlyMap<string, number>;
	signal: AbortSignal;
	onProgress: (message: string) => void;
}): Promise<number[] | null> {
	const videos = cameras.map(({ asset }) => asset);
	const referenceDuration = reference.duration!;
	if (
		referenceDuration < MIN_REFERENCE_SECONDS &&
		videos.every((video) => video.duration! < MIN_CAMERA_SECONDS)
	)
		return null;

	let referenceJob: Promise<Float32Array> | undefined;
	const loadReference = () =>
		(referenceJob ??= readSyncEnvelope({
			asset: mediaSource(reference),
			signal,
			read:
				reference.file && referenceDuration >= MIN_REFERENCE_SECONDS
					? readReferenceRanges
					: undefined,
		}));
	try {
		const guided = await guideTimelineSync({
			reference,
			videos: cameras,
			known,
			loadReference,
			signal,
			onProgress,
		});
		const indices = videos.map((_, index) => index);
		const verified = await verify({ indices, offsets: guided, full: false });
		const missing = indices.filter((index) => verified[index] == null);
		if (missing.length) {
			onProgress(
				localizeClientMessage(
					"Reading full audio for {v0} remaining cameras…",
					{ v0: String(missing.length) },
				),
			);
			const [master, full] = await Promise.all([
				loadReference(),
				mapConcurrent({
					items: missing,
					concurrency: syncReadConcurrency(),
					signal,
					task: (index, taskSignal) =>
						readSyncEnvelope({
							asset: mediaSource(videos[index]!),
							signal: taskSignal,
						}),
				}),
			]);
			onProgress(
				localizeClientMessage("Matching recordings on a shared timeline…"),
			);
			const matches = await runSyncWorker<
				Array<{ offset: number; confidence: number }>
			>({
				message: {
					type: "independent-probes",
					reference: master,
					probes: full.map((samples) => ({ at: 0, samples })),
					origin: 0,
					full: true,
				},
				signal,
			});
			const recovered = await verify({
				indices: missing,
				offsets: matches.map(({ offset, confidence }) =>
					confidence >= 0.65 ? offset : null,
				),
				full: true,
			});
			for (const index of missing) verified[index] = recovered[index];
		}
		return verified.every((offset) => offset != null) ? verified : null;
	} catch {
		signal.throwIfAborted();
		return null;
	}

	async function verify({
		indices,
		offsets,
		full,
	}: {
		indices: number[];
		offsets: Array<number | null>;
		full: boolean;
	}) {
		const matched = indices.filter((_, slot) => offsets[slot] != null);
		const verified: Array<number | undefined> = Array.from({
			length: videos.length,
		});
		if (!matched.length) return verified;
		const alignment: PodcastGroupAlignment = {
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
			alignment,
			assets: [reference, ...matched.map((index) => videos[index]!)],
			signal,
		});
		matched.forEach((index, slot) => {
			const target = slot + 1;
			if (result.drifting.includes(target)) return;
			if (
				!full &&
				result.unverified.includes(target) &&
				!known.has(videos[index]!.id)
			)
				return;
			verified[index] = result.offsets[target];
		});
		return verified;
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
	// Check early, middle and late positions first. Spend the other two reads
	// only on edges without independently agreeing waveform evidence.
	const byTarget = new Map<number, number[]>();
	windows.forEach((window, index) => {
		const indices = byTarget.get(window.targetIndex) ?? [];
		indices.push(index);
		byTarget.set(window.targetIndex, indices);
	});
	const first = [...byTarget.values()].flatMap((indices) =>
		indices.filter(
			(_, i) =>
				i === 0 ||
				i === Math.floor(indices.length / 2) ||
				i === indices.length - 1,
		),
	);
	const estimates = new Map<number, PodcastPrecisionEstimate>();
	await readWindows(first);
	let resolved = resolve();
	const uncertain = new Set([...resolved.drifting, ...resolved.unverified]);
	for (const [target, indices] of byTarget) {
		const strong = indices.filter(
			(index) => (estimates.get(index)?.confidence ?? 0) >= 0.2,
		);
		if (
			strong.length < 2 ||
			windows[strong.at(-1)!]!.targetStart - windows[strong[0]!]!.targetStart <
				12
		)
			uncertain.add(target);
	}
	const additional = windows.flatMap((window, index) =>
		uncertain.has(window.targetIndex) && !estimates.has(index) ? [index] : [],
	);
	if (additional.length) {
		await readWindows(additional);
		resolved = resolve();
	}
	return resolved;

	async function readWindows(indices: number[]) {
		await mapConcurrent({
			items: indices,
			concurrency: 2,
			signal,
			task: async (index, taskSignal) => {
				const window = windows[index]!;
				const result = await runSyncWorker<PodcastPrecisionEstimate>({
					message: {
						type: "precision",
						reference: mediaSource(assets[window.referenceIndex]!),
						target: mediaSource(assets[window.targetIndex]!),
						window,
					},
					signal: taskSignal,
				});
				estimates.set(index, result);
			},
		});
	}

	function resolve() {
		const completed = windows.flatMap((window, index) => {
			const result = estimates.get(index);
			return result ? [{ window, result }] : [];
		});
		return resolvePodcastPrecision({
			alignment,
			windows: completed.map(({ window }) => window),
			estimates: completed.map(({ result }) => result),
		});
	}
}

function readRange({
	asset,
	startSeconds,
	durationSeconds,
	signal,
}: {
	asset: MediaAsset;
	startSeconds: number;
	durationSeconds: number;
	signal: AbortSignal;
}) {
	return runSyncWorker<Float32Array>({
		message: {
			type: "read",
			asset: mediaSource(asset),
			range: { startSeconds, durationSeconds },
		},
		signal,
	});
}
