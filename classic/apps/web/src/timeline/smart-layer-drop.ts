import type { ParamValues } from "@/params";
import {
	SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
	SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
	clampSpeakerFrameBreakoutFade,
	readSpeakerFrameBreakoutSettings,
} from "@/simple-advanced-layers/speaker-frame-breakout";
import {
	PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
	PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
	PERSON_CUTOUT_LAYER_EFFECT_TYPE,
	readPersonCutoutLayerSettings,
} from "@/simple-advanced-layers/person-cutout-layer";
import type {
	CreateEffectElement,
	EffectElement,
	ElementTransitions,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	mediaTimeFromSeconds,
	roundMediaTime,
	type MediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import type { TimelineDragData } from "./drag";
import type { DropTarget } from "./types";

export function normalizeDropTargetForDrag({
	target,
	dragData,
}: {
	target: DropTarget;
	dragData: TimelineDragData;
}): DropTarget | null {
	if (
		dragData.type !== "effect" ||
		dragData.placement !== "layer-above-target"
	) {
		return target;
	}
	if (!target.targetElement) {
		return null;
	}
	return {
		...target,
		isNewTrack: true,
		insertPosition: "above",
	};
}

export function buildSpeakerFrameBreakoutLayerElement({
	startTime,
	duration = mediaTimeFromSeconds({
		seconds: SPEAKER_FRAME_BREAKOUT_DEFAULT_DURATION_SECONDS,
	}),
	name = "Speaker Frame Breakout",
	params,
	createdAt = new Date().toISOString(),
}: {
	startTime: MediaTime;
	duration?: MediaTime;
	name?: string;
	params?: Partial<ParamValues>;
	createdAt?: string;
}): CreateEffectElement {
	const resolvedParams: ParamValues = {
		...SPEAKER_FRAME_BREAKOUT_DEFAULT_PARAMS,
	};
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) {
			resolvedParams[key] = value;
		}
	}
	const element: CreateEffectElement = {
		type: "effect",
		effectType: SPEAKER_FRAME_BREAKOUT_EFFECT_TYPE,
		startTime,
		duration,
		name,
		params: resolvedParams,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
	};
	const settings = readSpeakerFrameBreakoutSettings({
		params: element.params,
	});
	return {
		...element,
		transitions: buildSpeakerFrameBreakoutFadeTransitions({
			element,
			fadeInDuration: settings.fadeInDuration,
			fadeOutDuration: settings.fadeOutDuration,
			createdAt,
		}),
	};
}

export function buildPersonCutoutLayerElement({
	startTime,
	duration = mediaTimeFromSeconds({
		seconds: PERSON_CUTOUT_LAYER_DEFAULT_DURATION_SECONDS,
	}),
	name = "Person Cutout Layer",
	params,
	createdAt = new Date().toISOString(),
}: {
	startTime: MediaTime;
	duration?: MediaTime;
	name?: string;
	params?: Partial<ParamValues>;
	createdAt?: string;
}): CreateEffectElement {
	const resolvedParams: ParamValues = {
		...PERSON_CUTOUT_LAYER_DEFAULT_PARAMS,
	};
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) {
			resolvedParams[key] = value;
		}
	}
	const element: CreateEffectElement = {
		type: "effect",
		effectType: PERSON_CUTOUT_LAYER_EFFECT_TYPE,
		startTime,
		duration,
		name,
		params: resolvedParams,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
	};
	const settings = readPersonCutoutLayerSettings({ params: element.params });
	return {
		...element,
		transitions: buildPersonCutoutLayerFadeTransitions({
			element,
			fadeInDuration: settings.fadeInDuration,
			fadeOutDuration: settings.fadeOutDuration,
			createdAt,
		}),
	};
}

export function buildPersonCutoutLayerFadeTransitions({
	element,
	fadeInDuration,
	fadeOutDuration,
	createdAt = new Date().toISOString(),
}: {
	element: Pick<EffectElement, "duration" | "transitions">;
	fadeInDuration: number;
	fadeOutDuration: number;
	createdAt?: string;
}): ElementTransitions {
	const fade = clampSpeakerFrameBreakoutFade({
		duration: element.duration,
		fadeInDuration,
		fadeOutDuration,
	});
	const inDuration = roundMediaTime({
		time: mediaTimeFromSeconds({ seconds: fade.fadeInDuration }),
	});
	const outDuration = roundMediaTime({
		time: mediaTimeFromSeconds({ seconds: fade.fadeOutDuration }),
	});
	return {
		...element.transitions,
		in: {
			id: element.transitions?.in?.id ?? generateUUID(),
			presetId: "fade",
			placement: "in",
			duration: inDuration,
			startTime: ZERO_MEDIA_TIME,
			createdAt: element.transitions?.in?.createdAt ?? createdAt,
		},
		out: {
			id: element.transitions?.out?.id ?? generateUUID(),
			presetId: "fade",
			placement: "out",
			duration: outDuration,
			startTime: roundMediaTime({
				time: Math.max(0, element.duration - outDuration),
			}),
			createdAt: element.transitions?.out?.createdAt ?? createdAt,
		},
	};
}

export function buildSpeakerFrameBreakoutFadeTransitions({
	element,
	fadeInDuration,
	fadeOutDuration,
	createdAt = new Date().toISOString(),
}: {
	element: Pick<EffectElement, "duration" | "transitions">;
	fadeInDuration: number;
	fadeOutDuration: number;
	createdAt?: string;
}): ElementTransitions {
	const fade = clampSpeakerFrameBreakoutFade({
		duration: element.duration,
		fadeInDuration,
		fadeOutDuration,
	});
	const inDuration = roundMediaTime({
		time: mediaTimeFromSeconds({ seconds: fade.fadeInDuration }),
	});
	const outDuration = roundMediaTime({
		time: mediaTimeFromSeconds({ seconds: fade.fadeOutDuration }),
	});
	return {
		...element.transitions,
		in: {
			id: element.transitions?.in?.id ?? generateUUID(),
			presetId: "fade",
			placement: "in",
			duration: inDuration,
			startTime: ZERO_MEDIA_TIME,
			createdAt: element.transitions?.in?.createdAt ?? createdAt,
		},
		out: {
			id: element.transitions?.out?.id ?? generateUUID(),
			presetId: "fade",
			placement: "out",
			duration: outDuration,
			startTime: roundMediaTime({
				time: Math.max(0, element.duration - outDuration),
			}),
			createdAt: element.transitions?.out?.createdAt ?? createdAt,
		},
	};
}
