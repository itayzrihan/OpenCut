import type { MediaAsset } from "@/media/types";
import { localizeClientMessage } from "@/i18n/client-messages";
import { syncAudioUrl } from "./native-audio";
import { mapConcurrent, runSyncWorker, syncReadConcurrency } from "./sync-jobs";

type Video = { asset: MediaAsset; angle: number };
type Evidence = { offset: number; confidence: number; at: number };

const WINDOW = 20;
const FRACTIONS = [0.15, 0.4, 0.65, 0.25, 0.8];
const AGREEMENT = 0.06;
const MIN_CONFIDENCE = 0.55;

export function consensusOffset(evidence: Evidence[]) {
	const valid = evidence.filter(
		(p) => p.confidence >= MIN_CONFIDENCE && Number.isFinite(p.offset),
	);
	const clusters = valid.map((p) =>
		valid.filter((q) => Math.abs(p.offset - q.offset) <= AGREEMENT),
	);
	clusters.sort((a, b) => b.length - a.length || score(b) - score(a));
	const best = clusters[0];
	if (
		!best ||
		best.length < 2 ||
		Math.max(...best.map((p) => p.at)) - Math.min(...best.map((p) => p.at)) < 10
	)
		return null;
	const competing = clusters.find(
		(cluster) =>
			cluster.length === best.length && cluster.every((p) => !best.includes(p)),
	);
	if (competing && score(competing) >= score(best) * 0.85) return null;
	const sorted = best.map((p) => p.offset).sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;

	function score(points: Evidence[]) {
		return points.reduce((sum, p) => sum + p.confidence, 0);
	}
}

async function captureTime({
	asset,
	signal,
}: {
	asset: MediaAsset;
	signal: AbortSignal;
}) {
	const url = syncAudioUrl({ asset, mode: "info" });
	try {
		if (url) {
			const response = await fetch(url, { cache: "no-store", signal });
			if (!response.ok) return null;
			const data = await response.json();
			return Number.isFinite(data.captureTime)
				? Number(data.captureTime)
				: null;
		}
		if (asset.file)
			return await runSyncWorker<number | null>({
				message: { type: "capture-time", asset: mediaSource(asset) },
				signal,
			});
		return null;
	} catch {
		signal.throwIfAborted();
		return null;
	}
}

function mediaSource({ file, url, name }: MediaAsset) {
	return { file, url, name };
}

export async function guideTimelineSync({
	reference,
	videos,
	known,
	loadReference,
	signal,
	onProgress,
}: {
	reference: MediaAsset;
	videos: Video[];
	known: ReadonlyMap<string, number>;
	loadReference: () => Promise<Float32Array>;
	signal: AbortSignal;
	onProgress: (message: string) => void;
}): Promise<Array<number | null>> {
	let indexJob: Promise<Float32Array> | undefined;
	const offsets = videos.map(({ asset }) => known.get(asset.id) ?? null);
	const stamps = await mapConcurrent({
		items: videos,
		concurrency: syncReadConcurrency(),
		signal,
		task: ({ asset }, taskSignal) => captureTime({ asset, signal: taskSignal }),
	});
	const count = videos.length;
	const prediction = (index: number) => {
		const stamp = stamps[index];
		if (stamp == null) return null;
		const priors = offsets
			.flatMap((offset, i) => {
				const otherStamp = stamps[i];
				return offset != null &&
					otherStamp != null &&
					videos[i]!.angle === videos[index]!.angle
					? [offset + (stamp - otherStamp) / 1000]
					: [];
			})
			.sort((a, b) => a - b);
		return priors.length ? priors[Math.floor(priors.length / 2)]! : null;
	};
	const retried = new Set<number>();
	const attemptedWithoutGuide = new Set<number>();
	const pending = new Set(
		videos.flatMap((_, i) => (offsets[i] == null ? [i] : [])),
	);
	const report = () =>
		onProgress(
			localizeClientMessage("Finding camera positions ({v0}/{v1})…", {
				v0: String(offsets.filter((offset) => offset != null).length),
				v1: String(count),
			}),
		);
	report();

	// Existing verified pairs and the longest useful clip per remaining angle
	// establish clocks. Failed clips never prevent a different anchor.
	while (
		pending.size ||
		[...attemptedWithoutGuide].some(
			(index) =>
				!retried.has(index) &&
				offsets[index] == null &&
				prediction(index) != null,
		)
	) {
		const guided = [...pending].filter((index) => prediction(index) != null);
		const leaders = new Map<number, number>();
		for (const index of pending) {
			const { asset, angle } = videos[index]!;
			if (prediction(index) != null) continue;
			const prior = leaders.get(angle);
			if (prior == null || asset.duration! > videos[prior]!.asset.duration!)
				leaders.set(angle, index);
		}
		for (const index of attemptedWithoutGuide) {
			if (
				!retried.has(index) &&
				offsets[index] == null &&
				prediction(index) != null
			) {
				retried.add(index);
				guided.push(index);
			}
		}
		const batch = [...guided, ...leaders.values()];
		if (!batch.length) break;
		await mapConcurrent({
			items: batch,
			concurrency: syncReadConcurrency(),
			signal,
			task: async (index, taskSignal) => {
				pending.delete(index);
				const prior = prediction(index);
				if (prior == null) attemptedWithoutGuide.add(index);
				try {
					offsets[index] = await findOffset({
						index,
						prior,
						signal: taskSignal,
					});
				} catch {
					taskSignal.throwIfAborted();
				}
				report();
			},
		});
	}
	return offsets;

	async function findOffset({
		index,
		prior,
		signal: jobSignal,
	}: {
		index: number;
		prior: number | null;
		signal: AbortSignal;
	}) {
		const target = videos[index]!.asset;
		if (target.duration! < 45) return null;
		const evidence: Evidence[] = [];
		const probes: Array<{ at: number; samples: Float32Array }> = [];
		const length = Math.min(WINDOW, target.duration! * 0.2);
		const duration = reference.duration!;
		const targetStamp = stamps[index];
		const externalAnchor =
			targetStamp == null
				? -1
				: offsets.findIndex(
						(offset, i) =>
							offset != null &&
							stamps[i] != null &&
							Math.abs(targetStamp - stamps[i]!) < 36_000_000,
					);
		const weak =
			externalAnchor < 0
				? null
				: offsets[externalAnchor]! +
					(targetStamp! - stamps[externalAnchor]!) / 1000;
		for (const fraction of FRACTIONS) {
			const at =
				Math.round(
					Math.min(target.duration! - length, target.duration! * fraction) *
						100,
				) / 100;
			const samples = await read({
				asset: target,
				start: at,
				length,
				signal: jobSignal,
			});
			probes.push({ at, samples });
			const firstEvidence = evidence.find(
				(point) => point.confidence >= MIN_CONFIDENCE,
			);
			const hint = prior ?? firstEvidence?.offset ?? weak;
			if (hint == null) continue;
			const radius = prior != null || firstEvidence ? 12 : 300;
			const expected = at + hint;
			const start = Math.max(0, Math.round((expected - radius) * 100) / 100);
			const available = Math.min(duration - start, length + 2 * radius);
			if (available < Math.min(length, 5)) continue;
			const window = await read({
				asset: reference,
				start,
				length: available,
				signal: jobSignal,
			});
			const [match] = await matchProbes({
				reference: window,
				probes: [{ at, samples }],
				origin: start,
				signal: jobSignal,
			});
			if (match) evidence.push(match);
			const offset = consensusOffset(evidence);
			if (offset != null) return offset;
		}
		const master = await loadReference();
		const matches = await matchProbes({
			reference: master,
			probes,
			origin: 0,
			signal: jobSignal,
		});
		const independent = consensusOffset(matches);
		if (independent != null) return independent;
		const ranked = await tryLandmarks({ target, probes, signal: jobSignal });
		for (const candidate of ranked) {
			const candidateEvidence = [];
			for (const probe of probes) {
				const start = Math.max(
					0,
					Math.round((candidate + probe.at - 2) * 100) / 100,
				);
				const window = master.subarray(
					Math.round(start * 100),
					Math.round((start + length + 4) * 100),
				);
				if (window.length < 100) continue;
				const [vote] = await matchProbes({
					reference: window,
					probes: [probe],
					origin: start,
					signal: jobSignal,
				});
				if (vote && Math.abs(vote.offset - candidate) < 2)
					candidateEvidence.push(vote);
				const offset = consensusOffset(candidateEvidence);
				if (offset != null) return offset;
			}
		}
		return null;
	}
	async function tryLandmarks({
		target,
		probes,
		signal: jobSignal,
	}: {
		target: MediaAsset;
		probes: Array<{ at: number; samples: Float32Array }>;
		signal: AbortSignal;
	}) {
		const referenceIndex = await (indexJob ??= fingerprint({
			asset: reference,
			start: 0,
			length: reference.duration!,
			full: true,
			signal,
		}));
		if (!referenceIndex.length) return [];
		const landmarks = [];
		for (const { at, samples } of probes) {
			const result = await fingerprint({
				asset: target,
				start: at,
				length: samples.length / 100,
				signal: jobSignal,
			});
			landmarks.push({ at, landmarks: result });
		}
		return runSyncWorker<number[]>({
			message: {
				type: "rank-landmarks",
				reference: referenceIndex,
				probes: landmarks,
			},
			signal: jobSignal,
		});
	}
}

async function read({
	asset,
	start,
	length,
	signal,
}: {
	asset: MediaAsset;
	start: number;
	length: number;
	signal: AbortSignal;
}) {
	return runSyncWorker<Float32Array>({
		message: {
			type: "read",
			asset: mediaSource(asset),
			range: { startSeconds: start, durationSeconds: length },
		},
		signal,
	});
}

function matchProbes({
	reference,
	probes,
	origin,
	signal,
}: {
	reference: Float32Array;
	probes: Array<{ at: number; samples: Float32Array }>;
	origin: number;
	signal: AbortSignal;
}) {
	return runSyncWorker<Evidence[]>({
		message: { type: "independent-probes", reference, probes, origin },
		signal,
	});
}

function fingerprint({
	asset,
	start,
	length,
	full,
	signal,
}: {
	asset: MediaAsset;
	start: number;
	length: number;
	full?: boolean;
	signal: AbortSignal;
}) {
	return runSyncWorker<Float32Array>({
		message: {
			type: "fingerprint",
			asset: mediaSource(asset),
			start,
			length,
			full,
		},
		signal,
	});
}
