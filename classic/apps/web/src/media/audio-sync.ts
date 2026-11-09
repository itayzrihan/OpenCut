import { resolveClipAudioTiming } from "opencut-wasm";
import type { AudioCapableElement } from "@/timeline/audio-state";
import { createRetimeMapping } from "@/retime/resolve";
import { TICKS_PER_SECOND } from "@/wasm";

/** The same native timing adapter feeds live playback, mixing and export. */
export function getClipAudioTiming(element: AudioCapableElement) {
	const startTime = element.startTime / TICKS_PER_SECOND;
	const duration = element.duration / TICKS_PER_SECOND;
	const trimStart = element.trimStart / TICKS_PER_SECOND;
	const offset = Number(element.params.audioSyncOffset ?? 0);
	const physicalOffset = Number(element.params.sourceAudioOffsetSeconds ?? 0);
	if (element.retime?.speedKeyframes?.length) {
		const mapping = createRetimeMapping({ retime: element.retime, trimStart });
		const delay = Number.isFinite(offset)
			? Math.max(-5, Math.min(5, offset))
			: 0;
		const physical = Math.abs(physicalOffset) <= 1e9 ? physicalOffset : 0;
		const leading = Math.max(
			0,
			Math.min(duration, mapping.clipAt(-physical - trimStart) + delay),
		);
		const curveTrimStart = trimStart + mapping.sourceAt(leading - delay);
		return {
			startTime: startTime + leading,
			duration: duration - leading,
			trimStart: Math.max(0, curveTrimStart + physical),
			curveTrimStart,
		};
	}
	return resolveClipAudioTiming({
		startTime,
		duration,
		trimStart,
		rate: element.retime?.rate ?? 1,
		offsetSeconds: offset,
		sourceOffsetSeconds: physicalOffset,
	});
}
