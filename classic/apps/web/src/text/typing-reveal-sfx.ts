import type { CreateLibraryAudioElement, TextElement } from "@/timeline";
import { buildLibraryAudioElement } from "@/timeline/element-utils";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import {
	planTypingRevealSfxSegments,
	TYPING_REVEAL_SFX_ASSET_ID,
	TYPING_REVEAL_SFX_SOURCE_SECONDS,
	TYPING_REVEAL_SFX_VOLUME_DB,
} from "./typing-reveal-sfx-preset";

export {
	TYPING_REVEAL_SFX_ASSET_ID,
	TYPING_REVEAL_SFX_SOURCE_SECONDS,
} from "./typing-reveal-sfx-preset";
export const TYPING_REVEAL_SFX_KIND = "letter-by-letter-typing-sfx";
export const TYPING_REVEAL_SFX_KIND_PARAM = "opencut.typingRevealSfx.kind";
export const TYPING_REVEAL_SFX_TEXT_ID_PARAM =
	"opencut.typingRevealSfx.textElementId";
export const TYPING_REVEAL_SFX_SEGMENT_PARAM =
	"opencut.typingRevealSfx.segmentIndex";

export function buildTypingRevealSfxElements({
	textElement,
}: {
	textElement: TextElement;
}): CreateLibraryAudioElement[] {
	const sourceDuration = mediaTimeFromSeconds({
		seconds: TYPING_REVEAL_SFX_SOURCE_SECONDS,
	});
	return planTypingRevealSfxSegments({
		durationTicks: textElement.duration,
	}).map(({ offsetTicks, durationTicks }, segmentIndex) => {
		const duration = mediaTime({ ticks: durationTicks });
		const element = buildLibraryAudioElement({
			libraryAssetId: TYPING_REVEAL_SFX_ASSET_ID,
			librarySourceType: "shared",
			name: "Letter by letter typing SFX",
			startTime: addMediaTime({
				a: textElement.startTime,
				b: mediaTime({ ticks: offsetTicks }),
			}),
			duration,
		});
		element.sourceDuration = sourceDuration;
		element.trimStart = ZERO_MEDIA_TIME;
		element.trimEnd = subMediaTime({ a: sourceDuration, b: duration });
		element.params = {
			...element.params,
			volume: TYPING_REVEAL_SFX_VOLUME_DB,
			[TYPING_REVEAL_SFX_KIND_PARAM]: TYPING_REVEAL_SFX_KIND,
			[TYPING_REVEAL_SFX_TEXT_ID_PARAM]: textElement.id,
			[TYPING_REVEAL_SFX_SEGMENT_PARAM]: segmentIndex,
		};
		return element;
	});
}
