export const TYPING_REVEAL_SFX_ASSET_ID =
	"da73d7d4-9b71-4a24-84ad-f6c51034354c";
export const TYPING_REVEAL_SFX_SOURCE_SECONDS = 15.6;
export const TYPING_REVEAL_SFX_SOURCE_TICKS = 1_872_000;
export const TYPING_REVEAL_SFX_VOLUME_DB = -5;

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
