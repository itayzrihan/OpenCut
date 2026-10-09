import type {
	AnimationChannel,
	ChannelData,
	CompositeChannelData,
} from "@/animation/types";

const LEGACY_ANIMATION_STORAGE_KEYS = new Set(["bindings", "channels"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isLeafChannelData(
	data: ChannelData | undefined,
): data is AnimationChannel {
	return isRecord(data) && Array.isArray(data.keys);
}

export function isCompositeChannelData(
	data: ChannelData | undefined,
): data is CompositeChannelData {
	return isRecord(data) && !Array.isArray(data.keys);
}

export function getChannelsFromData({
	data,
}: {
	data: ChannelData | undefined;
}): AnimationChannel[] {
	if (isLeafChannelData(data)) {
		return [data];
	}
	if (!isCompositeChannelData(data)) {
		return [];
	}
	return Object.values(data).filter(isLeafChannelData);
}

export function getChannelEntriesFromData({
	data,
}: {
	data: ChannelData | undefined;
}): Array<[string, AnimationChannel]> {
	if (isLeafChannelData(data)) {
		return [["value", data]];
	}
	if (!isCompositeChannelData(data)) {
		return [];
	}
	// JSON object order is not an animation contract: Rust and external files
	// may serialize components differently. Keep the product's RGBA primary
	// channel stable for selection, copied values and per-component key IDs.
	const rank = (key: string) => {
		const index = ["r", "g", "b", "a"].indexOf(key);
		return index < 0 ? 4 : index;
	};
	return Object.entries(data)
		.sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
		.flatMap(([componentKey, channel]) =>
			isLeafChannelData(channel) ? [[componentKey, channel]] : [],
		);
}

export function isAnimationStorageKey({ key }: { key: string }): boolean {
	return !LEGACY_ANIMATION_STORAGE_KEYS.has(key);
}
