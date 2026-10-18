import { getSourceTimeAtClipTime } from "@/retime";
import type { AudioClipSource } from "@/media/audio";

/** Decoder/DSP handles around only the selected source intervals. Never read
 * the whole episode before a late trim, or decode gaps between separate cuts. */
export function exportSourceWindows(clips: AudioClipSource[]) {
	const ranges = clips
		.map((clip) => ({
			start: Math.max(0, clip.trimStart - 0.25),
			end:
				clip.trimStart +
				getSourceTimeAtClipTime({
					clipTime: clip.duration,
					retime: clip.retime,
				}) +
				(clip.retime?.maintainPitch ? 3.1 : 0.1),
		}))
		.sort((a, b) => a.start - b.start);
	const merged: typeof ranges = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (last && range.start <= last.end)
			last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}
