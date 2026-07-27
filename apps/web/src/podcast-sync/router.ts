import {
	routePodcastMulticam,
	type PodcastMulticamSettings,
} from "opencut-wasm";

export interface PodcastSyncCut {
	timestamp: number;
	channelId: string;
	duration: number;
}

/**
 * Marshals web audio buffers into the platform-neutral Rust multicam router.
 * Speaker choice, crosstalk behavior, cut smoothing, and duration limits stay
 * identical across every UI shell.
 */
export function routePodcastSync({
	timeline,
	channelIds,
	duration,
	settings,
}: {
	timeline: Float32Array[];
	channelIds: string[];
	duration: number;
	settings: PodcastMulticamSettings;
}): PodcastSyncCut[] {
	return routePodcastMulticam({
		timeline: timeline.map((row) => Array.from(row)),
		channelIds,
		duration,
		settings,
	});
}
