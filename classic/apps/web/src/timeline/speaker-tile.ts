import {
	buildBackgroundRemovalEdit,
	getDefaultBackgroundRemovalSettings,
} from "@/background-removal";
import { buildDefaultMaskInstance, registerDefaultMasks } from "@/masks";
import type { Mask } from "@/masks/types";
import {
	findTrackInSceneTracks,
	updateElementInSceneTracks,
} from "@/timeline/track-element-update";
import { getDisplayTrackIds, splitTrackByType } from "@/timeline/track-order";
import { buildGraphicElement } from "@/timeline/element-utils";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import type {
	ElementRef,
	GraphicElement,
	SceneTracks,
	VideoElement,
} from "@/timeline/types";
import { BACKGROUND_PRESETS } from "@/backgrounds/presets";
import { getSourceSpanAtClipTime } from "@/retime";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	roundMediaTime,
	subMediaTime,
	type MediaTime,
} from "@/wasm";

export type SpeakerTilePresentation =
	| "rounded-rectangle"
	| "ellipse"
	| "rectangle"
	| "cutout";

export interface SpeakerTileOptions {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
	cameraDepth: number;
	presentation: SpeakerTilePresentation;
	removeBackground: boolean;
	cornerRadius: number;
	borderColor: string;
	borderWidth: number;
	cropTop?: number;
	startTime?: MediaTime;
	duration?: MediaTime;
	name?: string;
}

export interface SpeakerTileEditResult {
	tracks: SceneTracks;
	target: ElementRef;
}

export interface SpeakerFrameBreakoutOptions {
	positionX: number;
	positionY: number;
	scaleX: number;
	scaleY: number;
	cameraDepth: number;
	cropTop: number;
	cornerRadius: number;
	borderColor: string;
	borderWidth: number;
	backgroundPresetId: string;
	backgroundScaleX?: number;
	backgroundScaleY?: number;
	backgroundCameraDepth?: number;
	backgroundCameraLocked?: boolean;
	startTime?: MediaTime;
	duration?: MediaTime;
	name?: string;
}

export interface SpeakerFrameBreakoutEditResult {
	tracks: SceneTracks;
	source: ElementRef;
	foreground: ElementRef;
	base: ElementRef;
	background: ElementRef;
}

export function buildSpeakerTileEdit({
	tracks,
	trackId,
	elementId,
	options,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	options: SpeakerTileOptions;
}): SpeakerTileEditResult | null {
	const defaults = getDefaultBackgroundRemovalSettings();
	const duplicated = buildBackgroundRemovalEdit({
		tracks,
		trackId,
		elementId,
		duplicate: true,
		settings: {
			...defaults,
			enabled: options.removeBackground || options.presentation === "cutout",
			mode: "remove",
			quality: "balanced",
		},
	});
	if (!duplicated) return null;

	const targetTrack = findTrackInSceneTracks({
		tracks: duplicated.tracks,
		trackId: duplicated.target.trackId,
	});
	const targetElement = targetTrack?.elements.find(
		(element) => element.id === duplicated.target.elementId,
	);
	if (!targetElement || targetElement.type !== "video") return null;
	const visualRange = resolveSpeakerVisualRange({
		sourceElement: targetElement,
		startTime: options.startTime,
		duration: options.duration,
	});
	if (!visualRange) return null;

	const masks =
		options.presentation === "cutout"
			? (targetElement.masks ?? [])
			: [
					...(targetElement.masks ?? []),
					buildSpeakerTileMask({
						presentation: options.presentation,
						cornerRadius: options.cornerRadius,
						borderColor: options.borderColor,
						borderWidth: options.borderWidth,
						cropTop: options.cropTop ?? 0,
					}),
				];

	return {
		tracks: updateElementInSceneTracks({
			tracks: duplicated.tracks,
			trackId: duplicated.target.trackId,
			elementId: duplicated.target.elementId,
			update: (element) => {
				if (element.type !== "video") return element;
				return {
					...element,
					name: options.name?.trim() || `${targetElement.name} tile`,
					startTime: visualRange.startTime,
					duration: visualRange.duration,
					trimStart: visualRange.trimStart,
					trimEnd: visualRange.trimEnd,
					isSourceAudioEnabled: false,
					params: {
						...element.params,
						"transform.positionX": options.positionX,
						"transform.positionY": options.positionY,
						"transform.scaleX": options.scaleX,
						"transform.scaleY": options.scaleY,
						"camera.depth": options.cameraDepth,
					},
					masks,
				};
			},
		}),
		target: duplicated.target,
	};
}

/**
 * Builds the reusable "speaker breaks out of a framed video" composite.
 *
 * Display order is intentionally:
 * 1. background-removed speaker foreground,
 * 2. cropped framed duplicate,
 * 3. opaque stage background,
 * 4. original source (kept as the single dialogue source).
 *
 * Both visual duplicates inherit the source media timing/trim/retime and are
 * muted by buildSpeakerTileEdit. The result is designed to be committed as one
 * TracksSnapshotCommand so it stays atomic and undoable.
 */
export function buildSpeakerFrameBreakoutEdit({
	tracks,
	trackId,
	elementId,
	options,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	options: SpeakerFrameBreakoutOptions;
}): SpeakerFrameBreakoutEditResult | null {
	const sourceTrack = findTrackInSceneTracks({ tracks, trackId });
	const sourceElement = sourceTrack?.elements.find(
		(element) => element.id === elementId,
	);
	if (!sourceElement || sourceElement.type !== "video") return null;

	const backgroundPreset = BACKGROUND_PRESETS.find(
		(preset) => preset.id === options.backgroundPresetId,
	);
	if (!backgroundPreset) return null;
	const visualRange = resolveSpeakerVisualRange({
		sourceElement,
		startTime: options.startTime,
		duration: options.duration,
	});
	if (!visualRange) return null;

	const sharedOptions = {
		positionX: options.positionX,
		positionY: options.positionY,
		scaleX: options.scaleX,
		scaleY: options.scaleY,
		cameraDepth: options.cameraDepth,
		cornerRadius: options.cornerRadius,
		borderColor: options.borderColor,
		borderWidth: options.borderWidth,
		startTime: options.startTime,
		duration: options.duration,
	};
	const foreground = buildSpeakerTileEdit({
		tracks,
		trackId,
		elementId,
		options: {
			...sharedOptions,
			presentation: "cutout",
			removeBackground: true,
			name: options.name?.trim()
				? `${options.name.trim()} foreground`
				: `${sourceElement.name} breakout foreground`,
		},
	});
	if (!foreground) return null;

	const base = buildSpeakerTileEdit({
		tracks: foreground.tracks,
		trackId,
		elementId,
		options: {
			...sharedOptions,
			presentation: "rounded-rectangle",
			removeBackground: false,
			cropTop: options.cropTop,
			name: options.name?.trim()
				? `${options.name.trim()} frame`
				: `${sourceElement.name} breakout frame`,
		},
	});
	if (!base) return null;

	const backgroundTrackId = generateUUID();
	const backgroundElement: GraphicElement = {
		id: generateUUID(),
		...buildGraphicElement({
			definitionId: "preset-background",
			name: `${backgroundPreset.name} speaker stage`,
			startTime: visualRange.startTime,
			duration: visualRange.duration,
			params: {
				...backgroundPreset.params,
				"transform.scaleX": options.backgroundScaleX ?? 1,
				"transform.scaleY": options.backgroundScaleY ?? 1,
				"camera.depth": options.backgroundCameraDepth ?? 0.4,
				"camera.locked": options.backgroundCameraLocked ?? false,
			},
		}),
	};
	const backgroundTrack = {
		...buildEmptyTrack({
			id: backgroundTrackId,
			type: "graphic",
			name: "Speaker breakout stage",
		}),
		elements: [backgroundElement],
	};

	const sourceIndex = getDisplayTrackIds({ tracks: base.tracks }).indexOf(
		trackId,
	);
	if (sourceIndex < 0) return null;
	const withBackground = splitTrackByType({
		tracks: base.tracks,
		track: backgroundTrack,
		insertIndex: sourceIndex,
	});
	const compositeIds = [
		foreground.target.trackId,
		base.target.trackId,
		backgroundTrackId,
	];
	const remainingOrder = getDisplayTrackIds({ tracks: withBackground }).filter(
		(id) => !compositeIds.includes(id),
	);
	const nextSourceIndex = remainingOrder.indexOf(trackId);
	if (nextSourceIndex < 0) return null;
	remainingOrder.splice(nextSourceIndex, 0, ...compositeIds);

	return {
		tracks: {
			...withBackground,
			order: remainingOrder,
		},
		source: { trackId, elementId },
		foreground: foreground.target,
		base: base.target,
		background: {
			trackId: backgroundTrackId,
			elementId: backgroundElement.id,
		},
	};
}

function resolveSpeakerVisualRange({
	sourceElement,
	startTime,
	duration,
}: {
	sourceElement: VideoElement;
	startTime?: MediaTime;
	duration?: MediaTime;
}): {
	startTime: MediaTime;
	duration: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
} | null {
	const sourceEnd = addMediaTime({
		a: sourceElement.startTime,
		b: sourceElement.duration,
	});
	const visualStart = startTime ?? sourceElement.startTime;
	if (visualStart < sourceElement.startTime || visualStart >= sourceEnd) {
		return null;
	}
	const maximumDuration = subMediaTime({ a: sourceEnd, b: visualStart });
	const visualDuration = duration ?? maximumDuration;
	if (visualDuration <= 0 || visualDuration > maximumDuration) return null;

	const leadingTimelineSpan = subMediaTime({
		a: visualStart,
		b: sourceElement.startTime,
	});
	const visualEndOffset = addMediaTime({
		a: leadingTimelineSpan,
		b: visualDuration,
	});
	const leadingSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: leadingTimelineSpan,
			retime: sourceElement.retime,
		}),
	});
	const visibleSourceEnd = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: visualEndOffset,
			retime: sourceElement.retime,
		}),
	});
	const fullSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: sourceElement.duration,
			retime: sourceElement.retime,
		}),
	});
	const trailingSourceSpan = subMediaTime({
		a: fullSourceSpan,
		b: visibleSourceEnd,
	});

	return {
		startTime: visualStart,
		duration: visualDuration,
		trimStart: addMediaTime({
			a: sourceElement.trimStart,
			b: leadingSourceSpan,
		}),
		trimEnd: addMediaTime({
			a: sourceElement.trimEnd,
			b: trailingSourceSpan,
		}),
	};
}

function buildSpeakerTileMask({
	presentation,
	cornerRadius,
	borderColor,
	borderWidth,
	cropTop,
}: {
	presentation: Exclude<SpeakerTilePresentation, "cutout">;
	cornerRadius: number;
	borderColor: string;
	borderWidth: number;
	cropTop: number;
}): Mask {
	registerDefaultMasks();
	const mask = buildDefaultMaskInstance({ maskType: presentation });
	const safeCropTop = Math.max(0, Math.min(0.95, cropTop));
	const croppedHeight = 1 - safeCropTop;
	const croppedCenterY = safeCropTop / 2;

	if (mask.type === "rounded-rectangle") {
		return {
			...mask,
			params: {
				...mask.params,
				width: 1,
				height: croppedHeight,
				centerY: croppedCenterY,
				strokeColor: borderColor,
				strokeWidth: borderWidth,
				strokeAlign: "inside",
				cornerRadius,
			},
		};
	}
	if (mask.type === "ellipse") {
		return {
			...mask,
			params: {
				...mask.params,
				width: 1,
				height: croppedHeight,
				centerY: croppedCenterY,
				strokeColor: borderColor,
				strokeWidth: borderWidth,
				strokeAlign: "inside",
			},
		};
	}
	if (mask.type === "rectangle") {
		return {
			...mask,
			params: {
				...mask.params,
				width: 1,
				height: croppedHeight,
				centerY: croppedCenterY,
				strokeColor: borderColor,
				strokeWidth: borderWidth,
				strokeAlign: "inside",
			},
		};
	}
	throw new Error(`Unsupported speaker tile mask: ${mask.type}`);
}
