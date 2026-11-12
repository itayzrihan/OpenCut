import type { MediaAsset } from "@/media/types";
import {
	normalizePodcastMulticamSettings,
	orderPodcastClock,
	planPodcastPrecision,
	podcastMulticamDefaults,
	resolvePodcastPrecision,
	type PodcastGroupAlignment,
	type PodcastPrecisionEstimate,
} from "opencut-wasm";
import { mapConcurrent, runSyncWorker } from "./sync-jobs";
import type { OrderedPodcastColor } from "./order-timeline-color";

export type OrderedAudioPlacement = {
	mediaId: string;
	bindingRevision: number;
	start: number;
	duration: number;
};

export async function orderPodcastTimeline({
	audio,
	videos,
	name,
	signal,
	onProgress,
}: {
	audio: Array<{ asset: MediaAsset; gap: number }>;
	videos: Array<{ asset: MediaAsset; angle: number }>;
	name: string;
	signal: AbortSignal;
	onProgress: (message: string) => void;
}) {
	const assets = [...audio, ...videos].map(({ asset }) => asset);
	const durations = assets.map((asset) => asset.duration ?? 0);
	if (
		!audio.length ||
		audio.length > 32 ||
		!videos.length ||
		videos.length > 32 ||
		durations.some(
			(duration) =>
				!Number.isFinite(duration) || duration <= 0 || duration > 36_000,
		) ||
		durations.reduce(
			(total, duration) => total + Math.ceil(duration * 100),
			0,
		) > 32_000_000
	) {
		throw new Error(
			"Choose 1 to 32 readable video files and 1 to 32 readable audio files within the synchronization limits.",
		);
	}

	onProgress("Reading source audio…");
	const envelopes = await mapConcurrent({
		items: assets,
		concurrency: 3,
		signal,
		task: (asset, taskSignal) =>
			runSyncWorker<Float32Array>({
				message: {
					type: "read",
					asset: { file: asset.file, url: asset.url, name: asset.name },
				},
				signal: taskSignal,
			}),
	});
	onProgress("Matching recordings on a shared timeline…");
	const components = durations.map(() => -1);
	const offsets = durations.map(() => 0);
	let remaining = assets.map((_, index) => index);
	while (remaining.length) {
		signal.throwIfAborted();
		const searchable = remaining.filter(
			(index) => envelopes[index]!.length >= 100,
		);
		const alignment =
			searchable.length > 1
				? await runSyncWorker<PodcastGroupAlignment>({
						message: {
							type: "align",
							envelopes: searchable.map((index) => envelopes[index]),
							maxLagSeconds: Math.max(
								...searchable.map((index) => durations[index]!),
							),
						},
						signal,
					})
				: undefined;
		const slots = searchable.flatMap((_, slot) =>
			alignment?.offsets[slot] != null &&
			(alignment.confidence[slot] ?? 0) >= 0.24
				? [slot]
				: [],
		);
		const matched = slots.map((slot) => searchable[slot]!);
		const component = matched[0] ?? remaining[0]!;
		if (!alignment || matched.length < 2) {
			components[component] = component;
		} else {
			const group: PodcastGroupAlignment = {
				offsets: slots.map((slot) => alignment.offsets[slot]),
				confidence: slots.map((slot) => alignment.confidence[slot]!),
				parents: slots.map((slot) => {
					const parent = alignment.parents[slot];
					return parent == null ? undefined : slots.indexOf(parent);
				}),
				referenceIndex: slots.indexOf(alignment.referenceIndex),
			};
			const windows = planPodcastPrecision({
				alignment: group,
				durations: matched.map((index) => durations[index]!),
			});
			const estimates = await mapConcurrent({
				items: windows,
				concurrency: 2,
				signal,
				task: (window, taskSignal) =>
					runSyncWorker<PodcastPrecisionEstimate>({
						message: {
							type: "precision",
							reference: source(matched[window.referenceIndex]!),
							target: source(matched[window.targetIndex]!),
							window,
						},
						signal: taskSignal,
					}),
			});
			const precise = resolvePodcastPrecision({
				alignment: group,
				windows,
				estimates,
			});
			if (
				precise.drifting.length ||
				precise.offsets.some((offset) => offset == null)
			)
				throw new Error(
					"Some sources have inconsistent timing. Check the selected recordings and try again.",
				);
			matched.forEach((index, slot) => {
				components[index] = component;
				offsets[index] = precise.offsets[slot]!;
			});
		}
		remaining = remaining.filter((index) => components[index] === -1);
	}

	const audioComponents = new Set(components.slice(0, audio.length));
	const unmatched = videos.filter(
		(_, index) => !audioComponents.has(components[audio.length + index]!),
	);
	if (unmatched.length)
		throw new Error(
			`Cannot reliably synchronize: ${unmatched.map(({ asset }) => asset.name).join(", ")}. Check for overlapping, audible reference sound.`,
		);
	const clock = orderPodcastClock({
		durations,
		audioCount: audio.length,
		minimumGaps: audio.map(({ gap }, index) => (index ? gap : 0)),
		components,
		offsets,
	});
	if (!clock)
		throw new Error(
			"The audio order or requested gaps conflict with the recorded timing. Check the recording order and gaps.",
		);

	onProgress("Analyzing camera color and exposure…");
	const colors = await mapConcurrent({
		items: videos,
		concurrency: 2,
		signal,
		task: async ({ asset }, taskSignal) => {
			try {
				return await runSyncWorker<OrderedPodcastColor | undefined>({
					message: {
						type: "color",
						asset: { file: asset.file, url: asset.url },
						duration: asset.duration!,
					},
					signal: taskSignal,
				});
			} catch {
				taskSignal.throwIfAborted();
				return undefined;
			}
		},
	});
	const missingColor = videos
		.filter((_, index) => !colors[index])
		.map(({ asset }) => asset.name);
	const master = audio[0]!.asset;
	const plan = {
		settings: normalizePodcastMulticamSettings({
			...podcastMulticamDefaults({ quick: true }),
			sequenceName: name,
			keepCameraMics: false,
		}),
		orderedAudio: audio.map(
			({ asset }, index): OrderedAudioPlacement => ({
				mediaId: asset.id,
				bindingRevision: asset.bindingRevision ?? 0,
				start: clock.starts[index]!,
				duration: asset.duration!,
			}),
		),
		channels: videos.map(({ asset, angle }, index) => {
			const start = clock.starts[audio.length + index]!;
			return {
				id: `camera-${index + 1}`,
				name: asset.name,
				videoId: asset.id,
				audioId: master.id,
				videoBindingRevision: asset.bindingRevision ?? 0,
				audioBindingRevision: master.bindingRevision ?? 0,
				videoOffset: Math.max(0, -start),
				videoDelay: Math.max(0, start),
				audioOffset: 0,
				audioDelay: 0,
				angle,
				color: colors[index],
			};
		}),
		duration: clock.duration,
		cuts: [],
	};
	return { plan, missingColor };

	function source(index: number) {
		const { file, url, name } = assets[index]!;
		return { file, url, name };
	}
}
