import type { CreateLibraryAudioElement, TextElement } from "@/timeline";
import { buildLibraryAudioElement } from "@/timeline/element-utils";
import { getDefaultTransitionDurationSeconds } from "@/transitions/apply";
import { mediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getTextTransitionSfxPreset } from "./text-transition-sfx-presets";

export {
	getTextTransitionSfxPreset,
	hasTextTransitionSfx,
	type TextTransitionSfxPreset,
} from "./text-transition-sfx-presets";

export const TEXT_TRANSITION_SFX_KIND = "text-transition-in-sfx";
export const TEXT_TRANSITION_SFX_TEXT_ID_PARAM =
	"opencut.textTransitionSfx.textElementId";
export const TEXT_TRANSITION_SFX_KIND_PARAM = "opencut.textTransitionSfx.kind";
export const TEXT_TRANSITION_SFX_PRESET_PARAM =
	"opencut.textTransitionSfx.presetId";

export function buildTextTransitionSfxElement({
	textElement,
	transitionId,
	side,
	percent,
}: {
	textElement: TextElement;
	transitionId: string;
	side: "in" | "out";
	percent?: number;
}): CreateLibraryAudioElement | null {
	const preset = getTextTransitionSfxPreset({ transitionId, side });
	if (!preset) return null;

	const transitionDuration = mediaTimeFromSeconds({
		seconds: getDefaultTransitionDurationSeconds({
			element: textElement,
			percent,
		}),
	});
	const transitionStart =
		side === "out"
			? textElement.startTime + textElement.duration - transitionDuration
			: textElement.startTime;

	const startTime = mediaTime({
		ticks: Math.max(
			0,
			transitionStart - mediaTimeFromSeconds({ seconds: preset.leadInSeconds }),
		),
	});
	const element = buildLibraryAudioElement({
		libraryAssetId: preset.assetId,
		librarySourceType: "shared",
		name: preset.name,
		startTime,
		duration: mediaTimeFromSeconds({ seconds: preset.durationSeconds }),
	});
	element.sourceDuration = mediaTimeFromSeconds({
		seconds: preset.sourceDurationSeconds,
	});
	element.trimStart = mediaTimeFromSeconds({
		seconds: preset.trimStartSeconds,
	});
	element.trimEnd = mediaTimeFromSeconds({
		seconds: preset.trimEndSeconds,
	});
	element.params = {
		...element.params,
		volume: preset.volume,
		[TEXT_TRANSITION_SFX_KIND_PARAM]: TEXT_TRANSITION_SFX_KIND,
		[TEXT_TRANSITION_SFX_TEXT_ID_PARAM]: textElement.id,
		[TEXT_TRANSITION_SFX_PRESET_PARAM]: transitionId,
	};
	return element;
}
