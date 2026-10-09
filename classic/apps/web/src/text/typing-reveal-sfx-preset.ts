import definition from "../../../../rust/crates/timeline/data/typing-reveal-sfx.json";
export const TYPING_REVEAL_SFX_ASSET_ID = definition.assetId;
export const TYPING_REVEAL_SFX_SOURCE_SECONDS = definition.sourceSeconds;
export const TYPING_REVEAL_SFX_SOURCE_TICKS = definition.sourceTicks;
export const TYPING_REVEAL_SFX_VOLUME_DB = definition.volumeDb;

export function planTypingRevealSfxSegments({
	durationTicks,
	segmentTicks = TYPING_REVEAL_SFX_SOURCE_TICKS,
}: {
	durationTicks: number;
	segmentTicks?: number;
}): Array<{ offsetTicks: number; durationTicks: number }> {
	const segments: Array<{ offsetTicks: number; durationTicks: number }> = [];
	let remaining = Math.max(0, durationTicks);
	let offsetTicks = 0;
	while (remaining > 0) {
		const currentDuration = Math.min(remaining, segmentTicks);
		segments.push({ offsetTicks, durationTicks: currentDuration });
		remaining -= currentDuration;
		offsetTicks += currentDuration;
	}
	return segments;
}
