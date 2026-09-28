import { resolveClipAudioTiming } from "opencut-wasm";
import type { AudioCapableElement } from "@/timeline/audio-state";
import { TICKS_PER_SECOND } from "@/wasm";

/** The same native timing adapter feeds live playback, mixing and export. */
export function getClipAudioTiming(element: AudioCapableElement) {
	return resolveClipAudioTiming({
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		rate: element.retime?.rate ?? 1,
		offsetSeconds: Number(element.params.audioSyncOffset ?? 0),
	});
}
