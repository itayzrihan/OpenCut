import { localizeClientMessage } from "@/i18n/client-messages";
import type { MediaAsset } from "@/media/types";
import {
	normalizePodcastMulticamSettings,
	orderPodcastClock,
	podcastMulticamDefaults,
	type PodcastGroupAlignment,
} from "opencut-wasm";
import {
	mapConcurrent,
	readSyncEnvelope,
	runSyncWorker,
	syncReadConcurrency,
} from "./sync-jobs";
import {
	tryLongTimelineSync,
	verifyTimelineGroup,
} from "./order-timeline-fast-sync";
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
	known = new Map(),
	name,
	signal,
	onProgress,
}: {
	audio: Array<{ asset: MediaAsset; gap: number }>;
	videos: Array<{ asset: MediaAsset; angle: number }>;
	known?: ReadonlyMap<string, number>;
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
		videos.length > 32
	) {
		throw new Error(
			localizeClientMessage(
				"This job has {v0} video files and {v1} audio files. Select 1–32 of each.",
				{ v0: String(videos.length), v1: String(audio.length) },
			),
		);
	}
	const invalidDuration = assets.findIndex(
		(_, index) => !Number.isFinite(durations[index]) || durations[index]! <= 0,
	);
	if (invalidDuration >= 0)
		throw new Error(
			localizeClientMessage(
				"Could not read the duration of {v0}. Reconnect the original file and try again.",
				{ v0: assets[invalidDuration]!.name },
			),
		);
	const longSource = assets.findIndex((_, index) => durations[index]! > 36_000);
	if (longSource >= 0)
		throw new Error(
			localizeClientMessage(
				"{v0} exceeds the 10-hour limit for one source. Split the file before synchronizing.",
				{ v0: assets[longSource]!.name },
			),
		);
	if (
		durations.reduce(
			(total, duration) => total + Math.ceil(duration * 100),
			0,
		) > 32_000_000
	)
		throw new Error(
			localizeClientMessage(
				"The selected recordings exceed the combined synchronization limit. Select fewer or shorter files.",
			),
		);

	const fastOffsets =
		audio.length === 1
			? await tryLongTimelineSync({
					reference: audio[0]!.asset,
					videos,
					known,
					signal,
					onProgress,
				})
			: null;
	const components: number[] = durations.map(() => (fastOffsets ? 0 : -1));
	const offsets = fastOffsets ? [0, ...fastOffsets] : durations.map(() => 0);
	if (!fastOffsets) {
		let completed = 0;
		const reportRead = () =>
			onProgress(
				localizeClientMessage("Reading source audio ({v0}/{v1})…", {
					v0: String(completed),
					v1: String(assets.length),
				}),
			);
		reportRead();
		const envelopes = await mapConcurrent({
			items: assets,
			concurrency: syncReadConcurrency(),
			signal,
			task: async (asset, taskSignal) => {
				try {
					const envelope = await readSyncEnvelope({
						asset: { file: asset.file, url: asset.url, name: asset.name },
						signal: taskSignal,
					});
					completed++;
					reportRead();
					return envelope;
				} catch (error) {
					taskSignal.throwIfAborted();
					throw new Error(
						localizeClientMessage("Could not read sync audio from {v0}.", {
							v0: asset.name,
						}),
						{ cause: error },
					);
				}
			},
		});
		onProgress("Matching recordings on a shared timeline…");
		let remaining = assets.map((_, index) => index);
		let tryReferenceFirst = audio.length === 1 && videos.length > 1;
		while (remaining.length) {
			signal.throwIfAborted();
			const searchable = remaining.filter(
				(index) => envelopes[index]!.length >= 100,
			);
			const maxLagSeconds = Math.max(
				...searchable.map((index) => durations[index]!),
			);
			const directAlignment =
				tryReferenceFirst && searchable.length === assets.length
					? await runSyncWorker<PodcastGroupAlignment | null>({
							message: {
								type: "align-to-reference",
								envelopes,
								maxLagSeconds,
							},
							signal,
						})
					: undefined;
			tryReferenceFirst = false;
			const alignment =
				directAlignment ??
				(searchable.length > 1
					? await runSyncWorker<PodcastGroupAlignment>({
							message: {
								type: "align",
								envelopes: searchable.map((index) => envelopes[index]),
								maxLagSeconds,
							},
							signal,
						})
					: undefined);
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
				const precise = await verifyTimelineGroup({
					alignment: group,
					assets: matched.map((index) => assets[index]!),
					signal,
				});
				if (
					precise.drifting.length ||
					precise.offsets.some((offset) => offset == null)
				) {
					if (directAlignment) continue;
					throw new Error(
						"Some sources have inconsistent timing. Check the selected recordings and try again.",
					);
				}
				matched.forEach((index, slot) => {
					components[index] = component;
					offsets[index] = precise.offsets[slot]!;
				});
			}
			remaining = remaining.filter((index) => components[index] === -1);
		}
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
}
