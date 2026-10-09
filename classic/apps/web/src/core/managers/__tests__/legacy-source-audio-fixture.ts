// Frozen Classic reference for migration parity tests. Production mutations
// now live in crates/editor-api/src/operations/classic_source_audio.rs.
import { cloneAnimations } from "@/animation";
import type { ElementAnimations } from "@/animation/types";
import { DEFAULTS } from "@/timeline/defaults";
import type { CreateUploadAudioElement, VideoElement } from "@/timeline/types";

export function buildSeparatedAudioElement({
	sourceElement,
}: {
	sourceElement: VideoElement;
}): CreateUploadAudioElement {
	return {
		type: "audio",
		sourceType: "upload",
		mediaId: sourceElement.mediaId,
		name: sourceElement.name,
		duration: sourceElement.duration,
		startTime: sourceElement.startTime,
		trimStart: sourceElement.trimStart,
		trimEnd: sourceElement.trimEnd,
		sourceDuration: sourceElement.sourceDuration,
		params: {
			volume:
				typeof sourceElement.params.volume === "number"
					? sourceElement.params.volume
					: DEFAULTS.element.volume,
			muted: sourceElement.params.muted === true,
		},
		retime: sourceElement.retime
			? {
					rate: sourceElement.retime.rate,
					maintainPitch: sourceElement.retime.maintainPitch,
				}
			: undefined,
		animations: cloneVolumeAnimations({
			animations: sourceElement.animations,
		}),
	};
}

function cloneVolumeAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ElementAnimations | undefined {
	const volumeData = animations?.volume;
	if (!volumeData) {
		return undefined;
	}

	return cloneAnimations({
		animations: { volume: volumeData },
		shouldRegenerateKeyframeIds: true,
	});
}
