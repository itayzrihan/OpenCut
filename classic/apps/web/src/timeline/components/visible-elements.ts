import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import type { TimelineElement, TimelineTrack } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm/media-time";

export const DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX = 800;

type ElementIdLookup = {
	has: (elementId: string) => boolean;
	keys?: () => Iterable<string>;
	values?: () => Iterable<unknown>;
};

export interface TimelineElementVisibilityIndex {
	isSortedByStartTime: boolean;
	maxDuration: number;
	elementIndexById: ReadonlyMap<string, number>;
}

export function getElementSelectionKey({
	trackId,
	elementId,
}: {
	trackId: string;
	elementId: string;
}): string {
	return `${trackId}:${elementId}`;
}

export function getElementVisibilityScrollLeft({
	scrollLeft,
	overscanPx = DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX,
}: {
	scrollLeft: number;
	overscanPx?: number;
}) {
	if (!Number.isFinite(scrollLeft)) return 0;

	const safeScrollLeft = Math.max(0, scrollLeft);
	if (!Number.isFinite(overscanPx) || overscanPx <= 0) {
		return safeScrollLeft;
	}

	const bucketPx = Math.max(1, Math.floor(overscanPx / 2));
	return Math.floor(safeScrollLeft / bucketPx) * bucketPx;
}

export function getTimelineElementVisibilityIndex({
	elements,
}: {
	elements: TimelineElement[];
}): TimelineElementVisibilityIndex {
	let isSortedByStartTime = true;
	let maxDuration = 0;
	let previousStartTime = -Infinity;
	const elementIndexById = new Map<string, number>();

	for (let index = 0; index < elements.length; index += 1) {
		const element = elements[index];
		if (element.startTime < previousStartTime) {
			isSortedByStartTime = false;
		}
		previousStartTime = element.startTime;
		if (element.duration > maxDuration) {
			maxDuration = element.duration;
		}
		elementIndexById.set(element.id, index);
	}

	return { isSortedByStartTime, maxDuration, elementIndexById };
}

export function getVisibleTimelineElements({
	track,
	zoomLevel,
	scrollLeft,
	viewportWidth,
	selectedElementIds,
	targetElementId = null,
	draggedElementIds = null,
	overscanPx = DEFAULT_ELEMENT_HORIZONTAL_OVERSCAN_PX,
	visibilityIndex = getTimelineElementVisibilityIndex({
		elements: track.elements,
	}),
}: {
	track: TimelineTrack;
	zoomLevel: number;
	scrollLeft: number;
	viewportWidth: number;
	selectedElementIds: ReadonlySet<string>;
	targetElementId?: string | null;
	draggedElementIds?: ElementIdLookup | null;
	overscanPx?: number;
	visibilityIndex?: TimelineElementVisibilityIndex;
}): TimelineElement[] {
	if (viewportWidth <= 0) {
		return track.elements;
	}

	const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
		return track.elements;
	}

	const visibleLeftPx = Math.max(0, scrollLeft - overscanPx);
	const visibleRightPx = scrollLeft + viewportWidth + overscanPx;
	const visibleStartTime = (visibleLeftPx / pixelsPerSecond) * TICKS_PER_SECOND;
	const visibleEndTime = (visibleRightPx / pixelsPerSecond) * TICKS_PER_SECOND;
	const hasSelectedElements = selectedElementIds.size > 0;
	const hasTargetElement = targetElementId !== null;
	const hasDraggedElements = draggedElementIds !== null;
	const draggedElementIdIterable =
		draggedElementIds != null ? getElementIdIterable(draggedElementIds) : null;

	if (
		!visibilityIndex.isSortedByStartTime ||
		(hasDraggedElements && draggedElementIdIterable === null)
	) {
		return track.elements.filter((element) =>
			shouldShowElement({
				element,
				visibleStartTime,
				visibleEndTime,
				hasSelectedElements,
				selectedElementIds,
				hasTargetElement,
				targetElementId,
				hasDraggedElements,
				draggedElementIds,
			}),
		);
	}

	const startIndex = lowerBoundElementStartTime({
		elements: track.elements,
		time: Math.max(0, visibleStartTime - visibilityIndex.maxDuration),
	});
	const endIndex = upperBoundElementStartTime({
		elements: track.elements,
		time: visibleEndTime,
	});

	const visibleIndexes = new Set<number>();
	for (let index = startIndex; index < endIndex; index += 1) {
		const element = track.elements[index];
		if (element.startTime + element.duration >= visibleStartTime) {
			visibleIndexes.add(index);
		}
	}

	for (const elementId of selectedElementIds) {
		addForcedElementIndex({
			elementIndexById: visibilityIndex.elementIndexById,
			elementId,
			indexes: visibleIndexes,
		});
	}
	if (targetElementId !== null) {
		addForcedElementIndex({
			elementIndexById: visibilityIndex.elementIndexById,
			elementId: targetElementId,
			indexes: visibleIndexes,
		});
	}
	if (draggedElementIdIterable !== null) {
		for (const elementId of draggedElementIdIterable) {
			addForcedElementIndex({
				elementIndexById: visibilityIndex.elementIndexById,
				elementId,
				indexes: visibleIndexes,
			});
		}
	}

	return [...visibleIndexes]
		.sort((a, b) => a - b)
		.map((index) => track.elements[index]);
}

function shouldShowElement({
	element,
	visibleStartTime,
	visibleEndTime,
	hasSelectedElements,
	selectedElementIds,
	hasTargetElement,
	targetElementId,
	hasDraggedElements,
	draggedElementIds,
}: {
	element: TimelineElement;
	visibleStartTime: number;
	visibleEndTime: number;
	hasSelectedElements: boolean;
	selectedElementIds: ReadonlySet<string>;
	hasTargetElement: boolean;
	targetElementId: string | null;
	hasDraggedElements: boolean;
	draggedElementIds: ElementIdLookup | null;
}) {
	const elementEndTime = element.startTime + element.duration;
	if (
		elementEndTime >= visibleStartTime &&
		element.startTime <= visibleEndTime
	) {
		return true;
	}
	if (hasSelectedElements && selectedElementIds.has(element.id)) {
		return true;
	}
	if (hasTargetElement && targetElementId === element.id) {
		return true;
	}
	if (hasDraggedElements && draggedElementIds?.has(element.id)) {
		return true;
	}

	return false;
}

function lowerBoundElementStartTime({
	elements,
	time,
}: {
	elements: TimelineElement[];
	time: number;
}) {
	let low = 0;
	let high = elements.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (elements[mid].startTime < time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function upperBoundElementStartTime({
	elements,
	time,
}: {
	elements: TimelineElement[];
	time: number;
}) {
	let low = 0;
	let high = elements.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (elements[mid].startTime <= time) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function getElementIdIterable(lookup: ElementIdLookup): Iterable<string> | null {
	if (lookup.keys) {
		return lookup.keys();
	}
	if (lookup.values) {
		return getStringValues({ values: lookup.values() });
	}
	return null;
}

function* getStringValues({ values }: { values: Iterable<unknown> }) {
	for (const value of values) {
		if (typeof value === "string") {
			yield value;
		}
	}
}

function addForcedElementIndex({
	elementIndexById,
	elementId,
	indexes,
}: {
	elementIndexById: ReadonlyMap<string, number>;
	elementId: string;
	indexes: Set<number>;
}) {
	const index = elementIndexById.get(elementId);
	if (index !== undefined) {
		indexes.add(index);
	}
}
