import * as wasm from "opencut-wasm";

/** Narrow Rust boundary used by silence-cut orchestration and isolated tests. */
export const cutSilenceWasm = {
	normalizeTimelineTimeRanges: (
		options: Parameters<typeof wasm.normalizeTimelineTimeRanges>[0],
	) => wasm.normalizeTimelineTimeRanges(options),
	preserveClipsDuringTimeRemoval: (
		options: Parameters<typeof wasm.preserveAudioDuringTimeRemoval>[0],
	) => wasm.preserveAudioDuringTimeRemoval(options),
	realignCaptionWordsAfterTimeRemoval: (
		options: Parameters<typeof wasm.realignCaptionWordsAfterTimeRemoval>[0],
	) => wasm.realignCaptionWordsAfterTimeRemoval(options),
	removeCaptionWordTimeRanges: (
		options: Parameters<typeof wasm.removeCaptionWordTimeRanges>[0],
	) => wasm.removeCaptionWordTimeRanges(options),
};
