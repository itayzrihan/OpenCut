import type { TrackType, CreateTimelineElement } from "@/timeline";
import {
	buildGraphicElement,
	buildLibraryAudioElement,
} from "@/timeline/element-utils";
import type { UiElementBundle } from "@/ui-elements/catalog";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
} from "@/wasm";

export interface UiElementBundleTimelineItem {
	trackType: TrackType;
	element: CreateTimelineElement;
}

function offsetTime({
	startTime,
	offsetSeconds,
}: {
	startTime: MediaTime;
	offsetSeconds: number;
}): MediaTime {
	return addMediaTime({
		a: startTime,
		b: mediaTimeFromSeconds({ seconds: offsetSeconds }),
	});
}

export function buildUiElementBundleTimelineItems({
	bundle,
	startTime,
}: {
	bundle: UiElementBundle;
	startTime: MediaTime;
}): UiElementBundleTimelineItem[] {
	const graphics: UiElementBundleTimelineItem[] = bundle.graphics.map(
		(clip) => ({
			trackType: "graphic",
			element: buildGraphicElement({
				definitionId: clip.definitionId,
				name: clip.name,
				startTime: offsetTime({
					startTime,
					offsetSeconds: clip.startOffsetSeconds,
				}),
				duration: mediaTimeFromSeconds({ seconds: clip.durationSeconds }),
				params: clip.params,
			}),
		}),
	);

	const audio: UiElementBundleTimelineItem[] = bundle.audio.map((clip) => {
		const element = buildLibraryAudioElement({
			libraryAssetId: clip.libraryAssetId,
			librarySourceType: "shared",
			name: clip.name,
			startTime: offsetTime({
				startTime,
				offsetSeconds: clip.startOffsetSeconds,
			}),
			duration: mediaTimeFromSeconds({ seconds: clip.durationSeconds }),
		});
		element.sourceDuration = mediaTimeFromSeconds({
			seconds: clip.sourceDurationSeconds,
		});
		element.trimStart = mediaTimeFromSeconds({
			seconds: clip.trimStartSeconds,
		});
		element.trimEnd = mediaTimeFromSeconds({
			seconds: clip.trimEndSeconds,
		});
		element.params = { ...element.params, ...clip.params };
		return { trackType: "audio", element };
	});

	return [...graphics, ...audio];
}
