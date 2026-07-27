"use client";

import { memo, useMemo } from "react";
import { TimelineElement } from "./timeline-element";
import type {
	TimelineTrack,
	TimelineElement as TimelineElementType,
} from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ElementDragView } from "@/timeline";
import {
	getTimelineElementVisibilityIndex,
	getVisibleTimelineElements,
} from "./visible-elements";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	scrollLeft: number;
	viewportWidth: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
	selectedElementIds: ReadonlySet<string>;
	expandedElementIds: ReadonlySet<string>;
}

function TimelineTrackContentComponent({
	track,
	zoomLevel,
	scrollLeft,
	viewportWidth,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
	selectedElementIds,
	expandedElementIds,
}: TimelineTrackContentProps) {
	const elementVisibilityIndex = useMemo(
		() => getTimelineElementVisibilityIndex({ elements: track.elements }),
		[track.elements],
	);
	const visibleElements = useMemo(() => {
		return getVisibleTimelineElements({
			track,
			zoomLevel,
			scrollLeft,
			viewportWidth,
			selectedElementIds,
			targetElementId,
			draggedElementIds:
				dragView.kind === "dragging" ? dragView.memberTimeOffsets : null,
			visibilityIndex: elementVisibilityIndex,
		});
	}, [
		dragView,
		elementVisibilityIndex,
		scrollLeft,
		selectedElementIds,
		targetElementId,
		track,
		viewportWidth,
		zoomLevel,
	]);

	return (
		<div className="relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					visibleElements.map((element) => {
						const isSelected = selectedElementIds.has(element.id);

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={onResizeStart}
								onElementMouseDown={onElementMouseDown}
								onElementClick={onElementClick}
								dragView={dragView}
								isDropTarget={element.id === targetElementId}
								isExpanded={expandedElementIds.has(element.id)}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}

export const TimelineTrackContent = memo(TimelineTrackContentComponent);
TimelineTrackContent.displayName = "TimelineTrackContent";
