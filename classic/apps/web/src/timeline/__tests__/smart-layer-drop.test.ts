import { describe, expect, test } from "bun:test";
import type { EffectDragData } from "@/timeline/drag";
import {
	buildSpeakerFrameBreakoutLayerElement,
	normalizeDropTargetForDrag,
} from "@/timeline/smart-layer-drop";
import type { DropTarget } from "@/timeline/types";
import {
	mediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";

const smartDrag: EffectDragData = {
	id: "speaker-frame-breakout",
	name: "Speaker Frame Breakout",
	type: "effect",
	effectType: "speaker-frame-breakout",
	params: {},
	targetElementTypes: ["video"],
	placement: "layer-above-target",
};

describe("smart-layer drop placement", () => {
	test("creates a new effect track exactly above the targeted video", () => {
		const target: DropTarget = {
			trackIndex: 3,
			isNewTrack: false,
			insertPosition: null,
			xPosition: mediaTime({ ticks: 120_000 }),
			targetElement: { trackId: "video-track", elementId: "video" },
		};

		expect(normalizeDropTargetForDrag({ target, dragData: smartDrag })).toEqual({
			...target,
			isNewTrack: true,
			insertPosition: "above",
		});
	});

	test("rejects a smart-layer drop that is not over a video element", () => {
		const target: DropTarget = {
			trackIndex: 0,
			isNewTrack: true,
			insertPosition: null,
			xPosition: mediaTime({ ticks: 0 }),
			targetElement: null,
		};

		expect(normalizeDropTargetForDrag({ target, dragData: smartDrag })).toBeNull();
	});

	test("builds one unapplied six-second layer with native fade metadata", () => {
		const element = buildSpeakerFrameBreakoutLayerElement({
			startTime: mediaTimeFromSeconds({ seconds: 2 }),
			createdAt: "2026-07-28T00:00:00.000Z",
		});

		expect(element.type).toBe("effect");
		expect(element.effectType).toBe("speaker-frame-breakout");
		expect(mediaTimeToSeconds({ time: element.duration })).toBe(6);
		expect(element.params.matteApplied).toBe(false);
		expect(
			mediaTimeToSeconds({
				time: element.transitions?.in?.duration ?? ZERO_MEDIA_TIME,
			}),
		).toBe(0.35);
		expect(
			mediaTimeToSeconds({
				time: element.transitions?.out?.duration ?? ZERO_MEDIA_TIME,
			}),
		).toBe(0.35);
		expect(element.transitions?.in?.presetId).toBe("fade");
		expect(element.transitions?.out?.presetId).toBe("fade");
	});
});
