import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";
import { getDisplayTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { STICKER_INTRINSIC_SIZE_FALLBACK } from "@/stickers/intrinsic-size";
import { getGraphicSourceSize } from "@/graphics";
import {
	getTextMeasurementContext,
	measureTextElement,
} from "@/text/measure-element";
import { getElementLocalTime } from "@/animation";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildTransformFromParams } from "@/rendering";
import { buildTransitionAnimationsFromElement } from "@/transitions";

export interface ElementBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface ElementWithBounds {
	trackId: string;
	elementId: string;
	element: TimelineElement;
	bounds: ElementBounds;
}

const mediaAssetMapCache = new WeakMap<MediaAsset[], Map<string, MediaAsset>>();

function findTrackById({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	if (tracks.main.id === trackId) {
		return tracks.main;
	}

	for (const track of tracks.overlay) {
		if (track.id === trackId) {
			return track;
		}
	}

	for (const track of tracks.audio) {
		if (track.id === trackId) {
			return track;
		}
	}

	return null;
}

function getMediaAssetMap({
	mediaAssets,
}: {
	mediaAssets: MediaAsset[];
}): Map<string, MediaAsset> {
	const cached = mediaAssetMapCache.get(mediaAssets);
	if (cached) {
		return cached;
	}

	const mediaMap = new Map(mediaAssets.map((asset) => [asset.id, asset]));
	mediaAssetMapCache.set(mediaAssets, mediaMap);
	return mediaMap;
}

function getVisualElementBounds({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const containScale = Math.min(
		canvasWidth / sourceWidth,
		canvasHeight / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * transform.scaleX;
	const scaledHeight = sourceHeight * containScale * transform.scaleY;
	const cx = canvasWidth / 2 + transform.position.x;
	const cy = canvasHeight / 2 + transform.position.y;

	return {
		cx,
		cy,
		width: scaledWidth,
		height: scaledHeight,
		rotation: transform.rotate,
	};
}

function getTransformedRectBounds({
	canvasWidth,
	canvasHeight,
	rect,
	transform,
}: {
	canvasWidth: number;
	canvasHeight: number;
	rect: { left: number; top: number; width: number; height: number };
	transform: {
		scaleX: number;
		scaleY: number;
		position: { x: number; y: number };
		rotate: number;
	};
}): ElementBounds {
	const localCenterX = rect.left + rect.width / 2;
	const localCenterY = rect.top + rect.height / 2;
	const scaledCenterX = localCenterX * transform.scaleX;
	const scaledCenterY = localCenterY * transform.scaleY;
	const rotationRad = (transform.rotate * Math.PI) / 180;
	const cos = Math.cos(rotationRad);
	const sin = Math.sin(rotationRad);
	return {
		cx:
			canvasWidth / 2 +
			transform.position.x +
			scaledCenterX * cos -
			scaledCenterY * sin,
		cy:
			canvasHeight / 2 +
			transform.position.y +
			scaledCenterX * sin +
			scaledCenterY * cos,
		width: rect.width * transform.scaleX,
		height: rect.height * transform.scaleY,
		rotation: transform.rotate,
	};
}

/**
 * Bounds policy: bounds reflect base content geometry (text glyphs + background,
 * sticker/image/video content area) and base transform. Post-effect spill (blur,
 * glow) and mask-clipped regions are intentionally excluded — handles manipulate
 * the canonical element geometry, not visual effect output.
 */
function getElementBounds({
	element,
	canvasSize,
	mediaAsset,
	localTime,
}: {
	element: TimelineElement;
	canvasSize: { width: number; height: number };
	mediaAsset?: MediaAsset | null;
	localTime: number;
}): ElementBounds | null {
	if (element.type === "audio" || element.type === "effect") return null;
	if ("hidden" in element && element.hidden) return null;

	const { width: canvasWidth, height: canvasHeight } = canvasSize;

	if (element.type === "video" || element.type === "image") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: buildTransitionAnimationsFromElement({ element }),
			localTime,
		});
		const sourceWidth = mediaAsset?.width ?? canvasWidth;
		const sourceHeight = mediaAsset?.height ?? canvasHeight;
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth,
			sourceHeight,
			transform,
		});
	}

	if (element.type === "sticker") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: buildTransitionAnimationsFromElement({ element }),
			localTime,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: element.intrinsicWidth ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			sourceHeight: element.intrinsicHeight ?? STICKER_INTRINSIC_SIZE_FALLBACK,
			transform,
		});
	}

	if (element.type === "graphic") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: buildTransitionAnimationsFromElement({ element }),
			localTime,
		});
		const sourceSize = getGraphicSourceSize({
			definitionId: element.definitionId,
			params: element.params,
		});
		return getVisualElementBounds({
			canvasWidth,
			canvasHeight,
			sourceWidth: sourceSize.width,
			sourceHeight: sourceSize.height,
			transform,
		});
	}

	if (element.type === "text") {
		const transform = resolveTransformAtTime({
			baseTransform: buildTransformFromParams({ params: element.params }),
			animations: buildTransitionAnimationsFromElement({ element }),
			localTime,
		});

		const measured = measureTextElement({
			element,
			canvasHeight,
			localTime,
			ctx: getTextMeasurementContext(),
		});

		return getTransformedRectBounds({
			canvasWidth,
			canvasHeight,
			rect: measured.visualRect,
			transform,
		});
	}

	return null;
}

export const ROTATION_HANDLE_OFFSET = 24;

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Edge = "right" | "left" | "bottom";

export function getCornerPosition({
	bounds,
	corner,
}: {
	bounds: ElementBounds;
	corner: Corner;
}): { x: number; y: number } {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX =
		corner === "top-left" || corner === "bottom-left" ? -halfW : halfW;
	const localY =
		corner === "top-left" || corner === "top-right" ? -halfH : halfH;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getEdgeHandlePosition({
	bounds,
	edge,
}: {
	bounds: ElementBounds;
	edge: Edge;
}): { x: number; y: number } {
	const halfWidth = bounds.width / 2;
	const halfHeight = bounds.height / 2;
	const angleRad = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const localX =
		edge === "right" ? halfWidth : edge === "left" ? -halfWidth : 0;
	const localY = edge === "bottom" ? halfHeight : 0;
	return {
		x: bounds.cx + (localX * cos - localY * sin),
		y: bounds.cy + (localX * sin + localY * cos),
	};
}

export function getVisibleElementsWithBounds({
	tracks,
	currentTime,
	canvasSize,
	mediaAssets,
}: {
	tracks: SceneTracks;
	currentTime: number;
	canvasSize: { width: number; height: number };
	mediaAssets: MediaAsset[];
}): ElementWithBounds[] {
	const mediaMap = getMediaAssetMap({ mediaAssets });
	const displayTracks = getDisplayTracks({ tracks });

	const result: ElementWithBounds[] = [];

	for (
		let trackIndex = displayTracks.length - 1;
		trackIndex >= 0;
		trackIndex--
	) {
		const track = displayTracks[trackIndex];
		if (track.type === "audio" || ("hidden" in track && track.hidden)) {
			continue;
		}

		const activeElements: TimelineElement[] = [];
		for (const element of track.elements) {
			if ("hidden" in element && element.hidden) {
				continue;
			}
			if (
				currentTime < element.startTime ||
				currentTime >= element.startTime + element.duration
			) {
				continue;
			}
			activeElements.push(element);
		}

		if (activeElements.length > 1) {
			activeElements.sort((a, b) => {
				if (a.startTime !== b.startTime) return a.startTime - b.startTime;
				return a.id.localeCompare(b.id);
			});
		}

		for (const element of activeElements) {
			const localTime = getElementLocalTime({
				timelineTime: currentTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			});
			const mediaAsset =
				element.type === "video" || element.type === "image"
					? mediaMap.get(element.mediaId)
					: undefined;
			const bounds = getElementBounds({
				element,
				canvasSize,
				mediaAsset,
				localTime,
			});
			if (bounds) {
				result.push({
					trackId: track.id,
					elementId: element.id,
					element,
					bounds,
				});
			}
		}
	}

	return result;
}

export function getElementWithBounds({
	tracks,
	elementRef,
	currentTime,
	canvasSize,
	mediaAssets = [],
	mediaAsset = null,
}: {
	tracks: SceneTracks;
	elementRef: ElementRef;
	currentTime: number;
	canvasSize: { width: number; height: number };
	mediaAssets?: MediaAsset[];
	mediaAsset?: MediaAsset | null;
}): ElementWithBounds | null {
	const track = findTrackById({ tracks, trackId: elementRef.trackId });
	if (!track || track.type === "audio" || ("hidden" in track && track.hidden)) {
		return null;
	}

	const element = track.elements.find(
		(candidate) => candidate.id === elementRef.elementId,
	);
	if (!element || ("hidden" in element && element.hidden)) {
		return null;
	}
	if (
		currentTime < element.startTime ||
		currentTime >= element.startTime + element.duration
	) {
		return null;
	}

	const resolvedMediaAsset =
		element.type === "video" || element.type === "image"
			? (mediaAsset ?? getMediaAssetMap({ mediaAssets }).get(element.mediaId))
			: undefined;
	const bounds = getElementBounds({
		element,
		canvasSize,
		mediaAsset: resolvedMediaAsset,
		localTime: getElementLocalTime({
			timelineTime: currentTime,
			elementStartTime: element.startTime,
			elementDuration: element.duration,
		}),
	});
	if (!bounds) {
		return null;
	}

	return {
		trackId: track.id,
		elementId: element.id,
		element,
		bounds,
	};
}
