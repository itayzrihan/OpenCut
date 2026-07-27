"use client";

import {
	createContext,
	memo,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ComponentProps,
	type ReactNode,
} from "react";
import {
	useEditor,
	useEditorMediaAsset,
	useEditorSelection,
	useEditorMedia,
} from "@/editor/use-editor";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { AudioWaveform, WAVEFORM_GAIN_SAMPLE_COUNT } from "./audio-waveform";
import { AudioVolumeLine } from "./audio-volume-line";
import {
	useKeyframeDrag,
	type KeyframeDragState,
} from "@/timeline/hooks/element/use-keyframe-drag";
import { useKeyframeSelection } from "@/timeline/hooks/element/use-keyframe-selection";
import { useKeyframeBoxSelect } from "@/timeline/hooks/element/use-keyframe-box-select";
import { SelectionBox } from "@/selection/selection-box";
import { getElementKeyframes } from "@/animation";
import {
	canElementHaveAudio,
	canElementBeHidden,
	hasElementEffects,
	hasMediaId,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { getTrackHeight } from "./track-layout";
import { getTimelineElementClassName, TIMELINE_TRACK_THEME } from "./theme";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SelectionBoxBounds } from "@/selection/types";
import type {
	TimelineElement as TimelineElementType,
	TimelineTrack,
	ElementDragView,
	VideoElement,
	ImageElement,
	AudioElement,
} from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
} from "@/timeline/audio-separation";
import {
	buildCompactWaveformGainSamplesFromState,
	isElementMuted,
} from "@/timeline/audio-state";
import { getTimelinePixelsPerSecond } from "@/timeline";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import {
	addMediaTime,
	mediaTime,
	mediaTimeFromSeconds,
	type MediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";
import {
	getActionDefinition,
	type TAction,
	type TActionWithOptionalArgs,
	invokeAction,
} from "@/actions";
import { resolveStickerId } from "@/stickers";
import { buildGraphicPreviewUrl } from "@/graphics";
import { sharedLibraryService } from "@/shared-library";
import Image from "next/image";
import {
	ScissorIcon,
	Delete02Icon,
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
	VolumeMute02Icon,
	Search01Icon,
	Exchange01Icon,
	KeyframeIcon,
	MagicWand05Icon,
	TextIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { uppercase } from "@/utils/string";
import type { SelectedKeyframeRef, ElementKeyframe } from "@/animation/types";
import { cn } from "@/utils/ui";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";
import {
	getExpandedRows,
	getExpansionHeight,
	type ExpandedRow,
} from "./expanded-layout";
import { getTransitionPreset } from "@/transitions";
import type { MediaAsset } from "@/media/types";
import { UI_ELEMENT_GRAPHIC_ID } from "@/graphics/definitions/ui-element";
import { UiElementTimelineMarkers } from "@/ui-elements/components/timeline-markers";
import { useTimelineStore } from "@/timeline/timeline-store";

const KEYFRAME_INDICATOR_MIN_WIDTH_PX = 40;
const ELEMENT_RING_WIDTH_PX = 1.5;
const MIN_TRANSITION_SEGMENT_SECONDS = 0.1;
const EMPTY_EXPANDED_ROWS: ExpandedRow[] = [];

const PixelsPerSecondContext = createContext<number | null>(null);
const THUMBNAIL_ASPECT_RATIO = 16 / 9;

interface KeyframeIndicator {
	time: MediaTime;
	offsetPx: number;
	keyframes: SelectedKeyframeRef[];
}

export function buildKeyframeIndicator({
	keyframe,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
}: {
	keyframe: ElementKeyframe;
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
}): {
	time: MediaTime;
	offsetPx: number;
	keyframeRef: SelectedKeyframeRef;
} {
	const keyframeRef = {
		trackId,
		elementId,
		propertyPath: keyframe.propertyPath,
		keyframeId: keyframe.id,
	};
	const keyframeLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime + keyframe.time,
		zoomLevel,
	});
	return {
		time: keyframe.time,
		offsetPx: keyframeLeft - elementLeft,
		keyframeRef,
	};
}

export function getKeyframeIndicators({
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	elementWidth,
}: {
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	elementWidth: number;
}): KeyframeIndicator[] {
	if (elementWidth < KEYFRAME_INDICATOR_MIN_WIDTH_PX) {
		return [];
	}

	const keyframesByTime = new Map<MediaTime, KeyframeIndicator>();
	for (const keyframe of keyframes) {
		const indicator = buildKeyframeIndicator({
			keyframe,
			trackId,
			elementId,
			displayedStartTime,
			zoomLevel,
			elementLeft,
		});
		const existingIndicator = keyframesByTime.get(indicator.time);
		if (!existingIndicator) {
			keyframesByTime.set(indicator.time, {
				time: indicator.time,
				offsetPx: indicator.offsetPx,
				keyframes: [indicator.keyframeRef],
			});
			continue;
		}

		existingIndicator.keyframes.push(indicator.keyframeRef);
	}

	return [...keyframesByTime.values()].sort((a, b) => a.time - b.time);
}

export function getDisplayShortcut({ action }: { action: TAction }) {
	const defaultShortcuts = getActionDefinition({ action }).defaultShortcuts;
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

interface TimelineElementProps {
	element: TimelineElementType;
	track: TimelineTrack;
	zoomLevel: number;
	isSelected: boolean;
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
	dragView: ElementDragView;
	isDropTarget?: boolean;
	isExpanded: boolean;
}

function TimelineElementComponent({
	element,
	track,
	zoomLevel,
	isSelected,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	dragView,
	isDropTarget = false,
	isExpanded,
}: TimelineElementProps) {
	const mediaAsset = useEditorMediaAsset({
		mediaId: hasMediaId(element) ? element.mediaId : null,
	});

	const isDragging = dragView.kind === "dragging";
	const dragTimeOffset = isDragging
		? dragView.memberTimeOffsets.get(element.id)
		: undefined;
	const isBeingDragged = dragTimeOffset !== undefined;
	const dragOffsetY =
		isDragging && isBeingDragged
			? dragView.currentMouseY - dragView.startMouseY
			: 0;
	const elementStartTime =
		isDragging && isBeingDragged
			? addMediaTime({ a: dragView.currentTime, b: dragTimeOffset })
			: element.startTime;
	const displayedStartTime = elementStartTime;
	const displayedDuration = element.duration;
	const elementWidth = timelineTimeToPixels({
		time: displayedDuration,
		zoomLevel,
	});
	const timelinePixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const elementLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime,
		zoomLevel,
	});

	const expandedRows = useMemo(
		() =>
			isExpanded
				? getExpandedRows({ animations: element.animations })
				: EMPTY_EXPANDED_ROWS,
		[isExpanded, element.animations],
	);
	const hasExpandedRows = expandedRows.length > 0;
	const expansionHeight = getExpansionHeight({ rows: expandedRows });
	const baseTrackHeight = getTrackHeight({ type: track.type });
	const needsKeyframeSurface = isSelected || hasExpandedRows;

	return (
		<PixelsPerSecondContext.Provider value={timelinePixelsPerSecond}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className="absolute top-0 select-none"
						style={{
							left: `${elementLeft}px`,
							width: `${elementWidth}px`,
							height:
								expandedRows.length > 0
									? `${baseTrackHeight + expansionHeight}px`
									: "100%",
							transform:
								isDragging && isBeingDragged
									? `translate3d(0, ${dragOffsetY}px, 0)`
									: undefined,
						}}
					>
						{needsKeyframeSurface ? (
							<TimelineElementKeyframeSurface
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								isExpanded={hasExpandedRows}
								expandedRows={expandedRows}
								baseTrackHeight={baseTrackHeight}
								displayedStartTime={displayedStartTime}
								elementLeft={elementLeft}
								elementWidth={elementWidth}
								onElementClick={onElementClick}
								onElementMouseDown={onElementMouseDown}
								onResizeStart={onResizeStart}
								isDropTarget={isDropTarget}
								mediaAsset={mediaAsset}
							/>
						) : (
							<ElementInner
								element={element}
								track={track}
								isSelected={isSelected}
								isExpanded={false}
								baseTrackHeight={baseTrackHeight}
								expandedContent={null}
								onElementClick={onElementClick}
								onElementMouseDown={onElementMouseDown}
								onResizeStart={onResizeStart}
								isDropTarget={isDropTarget}
								zoomLevel={zoomLevel}
								mediaAsset={mediaAsset}
								elementWidth={elementWidth}
							/>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-64">
					<TimelineElementMenuContent
						element={element}
						trackId={track.id}
						mediaAsset={mediaAsset}
						isExpanded={isExpanded}
					/>
				</ContextMenuContent>
			</ContextMenu>
		</PixelsPerSecondContext.Provider>
	);
}

export const TimelineElement = memo(TimelineElementComponent);
TimelineElement.displayName = "TimelineElement";

function TimelineElementKeyframeSurface({
	element,
	track,
	zoomLevel,
	isSelected,
	isExpanded,
	expandedRows,
	baseTrackHeight,
	displayedStartTime,
	elementLeft,
	elementWidth,
	onElementClick,
	onElementMouseDown,
	onResizeStart,
	isDropTarget = false,
	mediaAsset,
}: {
	element: TimelineElementType;
	track: TimelineTrack;
	zoomLevel: number;
	isSelected: boolean;
	isExpanded: boolean;
	expandedRows: ExpandedRow[];
	baseTrackHeight: number;
	displayedStartTime: MediaTime;
	elementLeft: number;
	elementWidth: number;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
	mediaAsset: MediaAsset | null;
}) {
	const {
		keyframeDragState,
		handleKeyframeMouseDown,
		handleKeyframeClick,
		getVisualOffsetPx,
	} = useKeyframeDrag({ zoomLevel, element, displayedStartTime });
	const elementKeyframes = useMemo(
		() => getElementKeyframes({ animations: element.animations }),
		[element.animations],
	);
	const keyframeIndicators = useMemo(
		() =>
			isSelected
				? getKeyframeIndicators({
						keyframes: elementKeyframes,
						trackId: track.id,
						elementId: element.id,
						displayedStartTime,
						zoomLevel,
						elementLeft,
						elementWidth,
					})
				: [],
		[
			displayedStartTime,
			element.id,
			elementKeyframes,
			elementLeft,
			elementWidth,
			isSelected,
			track.id,
			zoomLevel,
		],
	);
	const expandedContent =
		isExpanded && expandedRows.length > 0 ? (
			<ExpandedKeyframeLaneSurface
				rows={expandedRows}
				keyframes={elementKeyframes}
				trackId={track.id}
				elementId={element.id}
				displayedStartTime={displayedStartTime}
				zoomLevel={zoomLevel}
				elementLeft={elementLeft}
				keyframeDragState={keyframeDragState}
				onKeyframeMouseDown={handleKeyframeMouseDown}
				onKeyframeClick={handleKeyframeClick}
				getVisualOffsetPx={getVisualOffsetPx}
			/>
		) : null;

	return (
		<>
			<ElementInner
				element={element}
				track={track}
				isSelected={isSelected}
				isExpanded={isExpanded}
				baseTrackHeight={baseTrackHeight}
				expandedContent={expandedContent}
				onElementClick={onElementClick}
				onElementMouseDown={onElementMouseDown}
				onResizeStart={onResizeStart}
				isDropTarget={isDropTarget}
				zoomLevel={zoomLevel}
				mediaAsset={mediaAsset}
				elementWidth={elementWidth}
			/>
			{isSelected && (
				<div
					className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
					style={{ height: `${baseTrackHeight}px` }}
				>
					<KeyframeIndicators
						indicators={keyframeIndicators}
						dragState={keyframeDragState}
						displayedStartTime={displayedStartTime}
						elementLeft={elementLeft}
						onKeyframeMouseDown={handleKeyframeMouseDown}
						onKeyframeClick={handleKeyframeClick}
						getVisualOffsetPx={getVisualOffsetPx}
					/>
				</div>
			)}
		</>
	);
}

function ExpandedKeyframeLaneSurface({
	rows,
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	keyframeDragState,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	rows: ExpandedRow[];
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	keyframeDragState: KeyframeDragState;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const {
		containerRef,
		selectionBox,
		isBoxSelecting,
		handleExpandedAreaMouseDown,
		handleExpandedAreaClick,
	} = useKeyframeBoxSelect({
		trackId,
		elementId,
		rows,
		keyframes,
		displayedStartTime,
		zoomLevel,
		elementLeft,
	});

	return (
		<ExpandedKeyframeLanes
			rows={rows}
			keyframes={keyframes}
			trackId={trackId}
			elementId={elementId}
			displayedStartTime={displayedStartTime}
			zoomLevel={zoomLevel}
			elementLeft={elementLeft}
			keyframeDragState={keyframeDragState}
			onKeyframeMouseDown={onKeyframeMouseDown}
			onKeyframeClick={onKeyframeClick}
			getVisualOffsetPx={getVisualOffsetPx}
			containerRef={containerRef}
			onLaneMouseDown={handleExpandedAreaMouseDown}
			onLaneClick={handleExpandedAreaClick}
			selectionBox={selectionBox}
			isBoxSelecting={isBoxSelecting}
		/>
	);
}

function TimelineElementMenuContent({
	element,
	trackId,
	mediaAsset,
	isExpanded,
}: {
	element: TimelineElementType;
	trackId: string;
	mediaAsset: MediaAsset | null;
	isExpanded: boolean;
}) {
	const editor = useEditor();
	const clipMediaAssets = useEditorMedia((currentEditor) =>
		currentEditor.media
			.getAssets()
			.filter((asset) => asset.type === "image" || asset.type === "video"),
	);
	const selectedElements = useEditorSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const requestRevealMedia = useAssetsPanelStore((s) => s.requestRevealMedia);
	const toggleElementExpanded = useTimelineStore(
		(s) => s.toggleElementExpanded,
	);
	const selectedElementCount = selectedElements.length;
	const isCurrentElementSelected = selectedElements.some(
		(selectedElement) =>
			selectedElement.trackId === trackId &&
			selectedElement.elementId === element.id,
	);
	const canMergeSelectedTextElements = useMemo(() => {
		if (selectedElements.length < 2) {
			return false;
		}
		const selectedTimelineElements = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		});
		return (
			selectedTimelineElements.length === selectedElements.length &&
			selectedTimelineElements.every(
				(selectedElement) => selectedElement.element.type === "text",
			)
		);
	}, [editor, selectedElements]);
	const hasAudio = mediaSupportsAudio({ media: mediaAsset });
	const isMuted = canElementHaveAudio(element) && isElementMuted({ element });
	const canToggleCurrentSourceAudio =
		selectedElementCount === 1 &&
		isCurrentElementSelected &&
		canToggleSourceAudio(element, mediaAsset);
	const sourceAudioLabel =
		element.type === "video"
			? getSourceAudioActionLabel({ element })
			: "Extract audio";
	const hasKeyframes = useMemo(
		() => getElementKeyframes({ animations: element.animations }).length > 0,
		[element.animations],
	);

	return (
		<>
			<ActionMenuItem
				action="split"
				icon={<HugeiconsIcon icon={ScissorIcon} />}
			>
				Split
			</ActionMenuItem>
			<CopyMenuItem />
			{selectedElementCount === 1 && (
				<ActionMenuItem
					action="duplicate-selected"
					icon={<HugeiconsIcon icon={Copy01Icon} />}
				>
					Duplicate
				</ActionMenuItem>
			)}
			{canMergeSelectedTextElements && (
				<>
					<ActionMenuItem
						action="merge-text-selected"
						icon={<HugeiconsIcon icon={TextIcon} />}
					>
						Connect text layers
					</ActionMenuItem>
					<ActionMenuItem
						action="merge-text-selected-multiline"
						icon={<HugeiconsIcon icon={TextIcon} />}
					>
						Connect as multiline
					</ActionMenuItem>
				</>
			)}
			{canElementHaveAudio(element) && hasAudio && (
				<MuteMenuItem
					isMultipleSelected={selectedElementCount > 1}
					isCurrentElementSelected={isCurrentElementSelected}
					isMuted={isMuted}
				/>
			)}
			{element.type === "text" && (
				<ContextMenuSub>
					<ContextMenuSubTrigger>Clip media into text</ContextMenuSubTrigger>
					<ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
						{element.clipMediaId && (
							<ContextMenuItem
								onClick={() =>
									editor.timeline.updateElements({
										updates: [{ trackId, elementId: element.id, patch: { clipMediaId: undefined } }],
									})
								}
							>
								Remove clipped media
							</ContextMenuItem>
						)}
						{clipMediaAssets.map((asset) => (
							<ContextMenuItem
								key={asset.id}
								onClick={() =>
									editor.timeline.updateElements({
										updates: [{ trackId, elementId: element.id, patch: { clipMediaId: asset.id } }],
									})
								}
							>
								{asset.name}
							</ContextMenuItem>
						))}
						{clipMediaAssets.length === 0 && (
							<ContextMenuItem disabled>Import image or video first</ContextMenuItem>
						)}
					</ContextMenuSubContent>
				</ContextMenuSub>
			)}
			{canToggleCurrentSourceAudio && (
				<ContextMenuItem
					icon={<HugeiconsIcon icon={ScissorIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						invokeAction("toggle-source-audio");
					}}
				>
					{sourceAudioLabel}
				</ContextMenuItem>
			)}
			{canElementBeHidden(element) && (
				<VisibilityMenuItem
					element={element}
					isMultipleSelected={selectedElementCount > 1}
					isCurrentElementSelected={isCurrentElementSelected}
				/>
			)}
			{hasKeyframes && (
				<ContextMenuItem
					icon={<HugeiconsIcon icon={KeyframeIcon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						toggleElementExpanded(element.id);
					}}
				>
					{isExpanded ? "Collapse keyframes" : "Expand keyframes"}
				</ContextMenuItem>
			)}
			{selectedElementCount === 1 && hasMediaId(element) && (
				<>
					<ContextMenuItem
						icon={<HugeiconsIcon icon={Search01Icon} />}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							requestRevealMedia(element.mediaId);
						}}
					>
						Reveal media
					</ContextMenuItem>
					<ContextMenuItem
						icon={<HugeiconsIcon icon={Exchange01Icon} />}
						disabled
					>
						Replace media
					</ContextMenuItem>
				</>
			)}
			<ContextMenuSeparator />
			<DeleteMenuItem
				isMultipleSelected={selectedElementCount > 1}
				isCurrentElementSelected={isCurrentElementSelected}
				elementType={element.type}
				selectedCount={selectedElementCount}
			/>
		</>
	);
}

function ElementInner({
	element,
	track,
	isSelected,
	isExpanded,
	baseTrackHeight,
	expandedContent,
	onElementClick,
	onElementMouseDown,
	onResizeStart,
	isDropTarget = false,
	zoomLevel,
	mediaAsset,
	elementWidth,
}: {
	element: TimelineElementType;
	track: TimelineTrack;
	isSelected: boolean;
	isExpanded: boolean;
	baseTrackHeight: number;
	expandedContent: React.ReactNode;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
	zoomLevel: number;
	mediaAsset: MediaAsset | null;
	elementWidth: number;
}) {
	const isReducedOpacity =
		(canElementBeHidden(element) && element.hidden) || isDropTarget;
	return (
		<div
			className="absolute top-0 bottom-0"
			style={{
				left: `${ELEMENT_RING_WIDTH_PX}px`,
				right: `${ELEMENT_RING_WIDTH_PX}px`,
			}}
		>
			<div
				className="absolute inset-0 rounded-sm"
				style={
					isSelected
						? {
								boxShadow: `0 0 0 ${ELEMENT_RING_WIDTH_PX}px var(--primary)`,
							}
						: undefined
				}
			>
				<div
					className={cn(
						"absolute inset-0 overflow-hidden rounded-sm",
						isExpanded && "bg-background",
					)}
				>
					{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events -- timeline clips are pointer gesture surfaces; nested clip controls must remain valid interactive elements. */}
					<div
						role="button"
						tabIndex={-1}
						className="absolute inset-0 size-full flex flex-col"
						onClick={(event) => onElementClick({ event, element, track })}
						onMouseDown={(event) =>
							onElementMouseDown({ event, element, track })
						}
					>
						<div
							className={cn(
								"relative flex shrink-0 items-center overflow-hidden",
								getTimelineElementClassName({
									type: getTrackTypeForElementType({
										elementType: element.type,
									}),
								}),
								isReducedOpacity && "opacity-50",
							)}
							style={{ height: `${baseTrackHeight}px` }}
						>
							<div className="flex flex-1 min-h-0 h-full items-center overflow-hidden">
								<ElementContent
									element={element}
									track={track}
									mediaAsset={mediaAsset}
								/>
							</div>
							<TransitionSegments
								element={element}
								trackId={track.id}
								zoomLevel={zoomLevel}
								baseTrackHeight={baseTrackHeight}
							/>
							{element.type === "graphic" &&
								element.definitionId === UI_ELEMENT_GRAPHIC_ID && (
									<UiElementTimelineMarkers
										element={element}
										trackId={track.id}
										elementWidth={elementWidth}
										baseTrackHeight={baseTrackHeight}
										isSelected={isSelected}
									/>
								)}
						</div>
						{expandedContent}
					</div>
				</div>
			</div>

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						element={element}
						track={track}
						onResizeStart={onResizeStart}
					/>
					<ResizeHandle
						side="right"
						element={element}
						track={track}
						onResizeStart={onResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function TransitionSegments({
	element,
	trackId,
	zoomLevel,
	baseTrackHeight,
}: {
	element: TimelineElementType;
	trackId: string;
	zoomLevel: number;
	baseTrackHeight: number;
}) {
	const editor = useEditor();
	const transitions = element.transitions;
	if (!transitions || element.type === "audio" || element.type === "effect") {
		return null;
	}

	const updateDuration = ({
		side,
		duration,
	}: {
		side: "in" | "out";
		duration: MediaTime;
	}) => {
		const currentTransition = transitions[side];
		if (!currentTransition) return;
		const currentStart =
			currentTransition.startTime ??
			(side === "out"
				? element.duration - currentTransition.duration
				: mediaTime({ ticks: 0 }));
		const currentEnd = mediaTime({
			ticks: Math.max(
				0,
				Math.min(element.duration, currentStart + currentTransition.duration),
			),
		});
		const minimumDuration = mediaTime({
			ticks: Math.min(
				element.duration,
				mediaTimeFromSeconds({ seconds: MIN_TRANSITION_SEGMENT_SECONDS }),
			),
		});
		const maxDuration =
			side === "out"
				? Math.max(minimumDuration, currentEnd)
				: Math.max(minimumDuration, element.duration - currentStart);
		const nextDuration = mediaTime({
			ticks: Math.round(
				Math.max(minimumDuration, Math.min(maxDuration, duration)),
			),
		});
		const nextStartTime =
			side === "out"
				? mediaTime({
						ticks: Math.max(0, currentEnd - nextDuration),
					})
				: currentStart;
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						transitions: {
							...transitions,
							[side]: {
								...currentTransition,
								duration: nextDuration,
								startTime: nextStartTime,
							},
						},
					},
				},
			],
		});
	};

	const removeTransition = ({ side }: { side: "in" | "out" }) => {
		const nextTransitions = { ...transitions };
		delete nextTransitions[side];
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: {
						transitions:
							nextTransitions.in || nextTransitions.out
								? nextTransitions
								: undefined,
					},
				},
			],
		});
	};

	return (
		<div className="pointer-events-none absolute inset-0">
			{transitions.in && (
				<TransitionSegment
					side="in"
					elementDuration={element.duration}
					duration={transitions.in.duration}
					startTime={transitions.in.startTime ?? mediaTime({ ticks: 0 })}
					presetId={transitions.in.presetId}
					zoomLevel={zoomLevel}
					baseTrackHeight={baseTrackHeight}
					onDurationChange={(duration) =>
						updateDuration({ side: "in", duration })
					}
					onRemove={() => removeTransition({ side: "in" })}
				/>
			)}
			{transitions.out && (
				<TransitionSegment
					side="out"
					elementDuration={element.duration}
					duration={transitions.out.duration}
					startTime={
						transitions.out.startTime ??
						mediaTime({
							ticks: Math.max(0, element.duration - transitions.out.duration),
						})
					}
					presetId={transitions.out.presetId}
					zoomLevel={zoomLevel}
					baseTrackHeight={baseTrackHeight}
					onDurationChange={(duration) =>
						updateDuration({ side: "out", duration })
					}
					onRemove={() => removeTransition({ side: "out" })}
				/>
			)}
		</div>
	);
}

function TransitionSegment({
	side,
	elementDuration,
	duration,
	startTime,
	presetId,
	zoomLevel,
	baseTrackHeight,
	onDurationChange,
	onRemove,
}: {
	side: "in" | "out";
	elementDuration: MediaTime;
	duration: MediaTime;
	startTime: MediaTime;
	presetId: string;
	zoomLevel: number;
	baseTrackHeight: number;
	onDurationChange: (duration: MediaTime) => void;
	onRemove: () => void;
}) {
	const preset = getTransitionPreset({ id: presetId });
	const clampedStartTime = mediaTime({
		ticks: Math.max(0, Math.min(elementDuration, startTime)),
	});
	const visibleDuration = mediaTime({
		ticks: Math.max(0, Math.min(duration, elementDuration - clampedStartTime)),
	});
	const widthPx = Math.max(
		8,
		timelineTimeToPixels({
			time: visibleDuration,
			zoomLevel,
		}),
	);
	const leftPx = timelineTimeToPixels({
		time: clampedStartTime,
		zoomLevel,
	});
	const height = Math.max(14, Math.floor(baseTrackHeight / 2));

	const handlePointerDown = (event: React.MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		const startX = event.clientX;
		const startDuration = duration;
		const pixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });

		const handleMouseMove = (moveEvent: MouseEvent) => {
			const deltaSeconds = (moveEvent.clientX - startX) / pixelsPerSecond;
			const deltaTime = mediaTimeFromSeconds({
				seconds: side === "in" ? deltaSeconds : -deltaSeconds,
			});
			onDurationChange(addMediaTime({ a: startDuration, b: deltaTime }));
		};
		const handleMouseUp = () => {
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="button"
					tabIndex={-1}
					className="pointer-events-auto absolute bottom-1 z-10 overflow-hidden rounded-sm border border-white/30 bg-black/35 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] backdrop-blur-sm"
					style={{
						left: leftPx,
						width: widthPx,
						height,
					}}
					onMouseDown={(event) => event.stopPropagation()}
					onClick={(event) => event.stopPropagation()}
					onKeyDown={(event) => event.stopPropagation()}
					title={`${side === "in" ? "In" : "Out"} transition: ${preset.label}`}
				>
					<div className="flex h-full items-center gap-1 px-1.5 text-[0.6rem] leading-none text-white/90">
						<HugeiconsIcon icon={MagicWand05Icon} className="size-3 shrink-0" />
						<span className="truncate">{preset.label}</span>
					</div>
					<button
						type="button"
						className={cn(
							"absolute top-0 h-full w-2 cursor-ew-resize bg-white/10 hover:bg-white/25",
							side === "in" ? "right-0" : "left-0",
						)}
						onMouseDown={handlePointerDown}
						aria-label={`Resize ${side} transition`}
					/>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				<ContextMenuItem
					icon={<HugeiconsIcon icon={Delete02Icon} />}
					variant="destructive"
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						onRemove();
					}}
				>
					Remove transition
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ResizeHandle({
	side,
	element,
	track,
	onResizeStart,
}: {
	side: "left" | "right";
	element: TimelineElementType;
	track: TimelineTrack;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
}) {
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={cn(
				"absolute top-0 bottom-0 w-2",
				isLeft ? "-left-1 cursor-w-resize" : "-right-1 cursor-e-resize",
			)}
			onMouseDown={(event) => onResizeStart({ event, element, track, side })}
			onClick={(event) => event.stopPropagation()}
			aria-label={`${isLeft ? "Left" : "Right"} resize handle`}
		></button>
	);
}

function KeyframeIndicators({
	indicators,
	dragState,
	displayedStartTime,
	elementLeft,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	indicators: KeyframeIndicator[];
	dragState: KeyframeDragState;
	displayedStartTime: MediaTime;
	elementLeft: number;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();
	const orderedKeyframes = indicators.flatMap(
		(indicator) => indicator.keyframes,
	);

	return indicators.map((indicator) => {
		const isIndicatorSelected = indicator.keyframes.some((keyframe) =>
			isKeyframeSelected({ keyframe }),
		);
		const isBeingDragged = indicator.keyframes.some((keyframe) =>
			dragState.draggingKeyframeIds.has(keyframe.keyframeId),
		);
		const visualOffsetPx = getVisualOffsetPx({
			indicatorTime: indicator.time,
			indicatorOffsetPx: indicator.offsetPx,
			isBeingDragged,
			displayedStartTime,
			elementLeft,
		});

		return (
			<button
				key={indicator.time}
				type="button"
				className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab mr-0.5"
				style={{ left: visualOffsetPx }}
				onMouseDown={(event) =>
					onKeyframeMouseDown({ event, keyframes: indicator.keyframes })
				}
				onClick={(event) =>
					onKeyframeClick({
						event,
						keyframes: indicator.keyframes,
						orderedKeyframes,
						indicatorTime: indicator.time,
					})
				}
				aria-label="Select keyframe"
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					className={cn(
						"size-3.5 text-black",
						isIndicatorSelected ? "fill-primary" : "fill-white",
					)}
					strokeWidth={1.5}
				/>
			</button>
		);
	});
}

function ExpandedKeyframeLanes({
	rows,
	keyframes,
	trackId,
	elementId,
	displayedStartTime,
	zoomLevel,
	elementLeft,
	keyframeDragState,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
	containerRef,
	onLaneMouseDown,
	onLaneClick,
	selectionBox,
	isBoxSelecting,
}: {
	rows: ExpandedRow[];
	keyframes: ElementKeyframe[];
	trackId: string;
	elementId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	elementLeft: number;
	keyframeDragState: KeyframeDragState;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onLaneMouseDown: (event: React.MouseEvent) => void;
	onLaneClick: (event: React.MouseEvent) => void;
	selectionBox: {
		bounds: SelectionBoxBounds;
	} | null;
	isBoxSelecting: boolean;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		elementLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();

	const orderedKeyframes = useMemo(
		() =>
			[...keyframes]
				.sort(
					(a, b) =>
						a.time - b.time || a.propertyPath.localeCompare(b.propertyPath),
				)
				.map((kf) => ({
					trackId,
					elementId,
					propertyPath: kf.propertyPath,
					keyframeId: kf.id,
				})),
		[keyframes, trackId, elementId],
	);

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (keyframe lanes); keyboard control over keyframes is via global timeline shortcuts, not per-element focus.
		<div
			ref={containerRef}
			className="relative flex flex-col"
			onMouseDown={onLaneMouseDown}
			onClick={onLaneClick}
		>
			{rows.map((row) => {
				const laneKeyframes = keyframes.filter(
					(kf) => kf.propertyPath === row.propertyPath,
				);
				return (
					<div
						key={row.propertyPath}
						className={cn("relative flex items-center bg-muted/50")}
						style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
					>
						{laneKeyframes.map((kf) => {
							const keyframeRef: SelectedKeyframeRef = {
								trackId,
								elementId,
								propertyPath: row.propertyPath,
								keyframeId: kf.id,
							};
							const isBeingDragged = keyframeDragState.draggingKeyframeIds.has(
								kf.id,
							);
							const kfLeft = timelineTimeToSnappedPixels({
								time: displayedStartTime + kf.time,
								zoomLevel,
							});
							const offsetPx = kfLeft - elementLeft;
							const visualOffset = getVisualOffsetPx({
								indicatorTime: kf.time,
								indicatorOffsetPx: offsetPx,
								isBeingDragged,
								displayedStartTime,
								elementLeft,
							});
							const isSelected = isKeyframeSelected({
								keyframe: keyframeRef,
							});

							return (
								<button
									key={kf.id}
									type="button"
									className={cn(
										"pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab",
										isBoxSelecting && "pointer-events-none",
									)}
									style={{ left: visualOffset }}
									onMouseDown={(event) => {
										event.stopPropagation();
										onKeyframeMouseDown({
											event,
											keyframes: [keyframeRef],
										});
									}}
									onClick={(event) => {
										event.stopPropagation();
										onKeyframeClick({
											event,
											keyframes: [keyframeRef],
											orderedKeyframes,
											indicatorTime: kf.time,
										});
									}}
									aria-label="Select keyframe"
								>
									<HugeiconsIcon
										icon={KeyframeIcon}
										className={cn(
											"size-3.5 text-black mr-1",
											isSelected ? "fill-primary" : "fill-white",
										)}
										strokeWidth={1.5}
									/>
								</button>
							);
						})}
					</div>
				);
			})}
			{selectionBox && <SelectionBox bounds={selectionBox.bounds} />}
		</div>
	);
}

interface ElementContentProps {
	element: TimelineElementType;
	track: TimelineTrack;
	mediaAsset: MediaAsset | null;
}

function TextElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "text" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start pl-2">
			<span className="truncate text-xs text-white">
				{typeof element.params.content === "string"
					? element.params.content
					: ""}
			</span>
		</div>
	);
}

function EffectElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "effect" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start gap-1 pl-2">
			<HugeiconsIcon
				icon={MagicWand05Icon}
				className="size-4 shrink-0 text-white"
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function StickerElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "sticker" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={resolveStickerId({
					stickerId: element.stickerId,
					options: { width: 20, height: 20 },
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function GraphicElementContent({
	element,
}: {
	element: Extract<TimelineElementType, { type: "graphic" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={buildGraphicPreviewUrl({
					definitionId: element.definitionId,
					params: element.params,
					size: 20,
				})}
				alt={element.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{element.name}</span>
		</div>
	);
}

function AudioElementContent({
	element,
	trackId,
	mediaAsset,
}: {
	element: AudioElement;
	trackId: string;
	mediaAsset: MediaAsset | null;
}) {
	const pixelsPerSecond = useContext(PixelsPerSecondContext);
	if (pixelsPerSecond === null) {
		throw new Error(
			"AudioElementContent must be rendered inside PixelsPerSecondContext.Provider",
		);
	}
	const [sharedAudioSource, setSharedAudioSource] = useState<{
		assetId: string;
		file?: File;
		url?: string;
	} | null>(null);
	const libraryAssetId =
		element.sourceType === "library" ? element.libraryAssetId : undefined;

	useEffect(() => {
		if (!libraryAssetId) {
			return;
		}

		let shouldIgnore = false;
		let objectUrl: string | null = null;

		void sharedLibraryService
			.getAudioAssetFile({ id: libraryAssetId })
			.then((file) => {
				if (shouldIgnore) return;
				if (!file || typeof URL === "undefined") {
					setSharedAudioSource({
						assetId: libraryAssetId,
						file: file ?? undefined,
					});
					return;
				}
				objectUrl = URL.createObjectURL(file);
				setSharedAudioSource({
					assetId: libraryAssetId,
					file,
					url: objectUrl,
				});
			})
			.catch((error) => {
				console.warn("Failed to load shared audio asset:", error);
				if (!shouldIgnore) {
					setSharedAudioSource({
						assetId: libraryAssetId,
					});
				}
			});

		return () => {
			shouldIgnore = true;
			if (objectUrl && typeof URL !== "undefined") {
				URL.revokeObjectURL(objectUrl);
			}
		};
	}, [libraryAssetId]);
	const currentSharedAudioSource =
		libraryAssetId && sharedAudioSource?.assetId === libraryAssetId
			? sharedAudioSource
			: null;

	const audioBuffer =
		element.sourceType === "library" ? element.buffer : undefined;
	const audioUrl =
		element.sourceType === "library"
			? (currentSharedAudioSource?.url ?? element.sourceUrl)
			: mediaAsset?.url;
	const sourceFile =
		element.sourceType === "upload"
			? mediaAsset?.file
			: currentSharedAudioSource?.file;
	const sourceKey =
		element.sourceType === "upload"
			? buildWaveformSourceKey({ kind: "media", id: element.mediaId })
			: buildWaveformSourceKey({
					kind: "library",
					id: element.libraryAssetId ?? element.sourceUrl ?? element.id,
				});
	const mediaLabel = mediaAsset?.name ?? element.name;
	const gainSamples = useMemo(
		() =>
			buildCompactWaveformGainSamplesFromState({
				animations: element.animations,
				count: WAVEFORM_GAIN_SAMPLE_COUNT,
				duration: element.duration,
				fadeInDuration: element.params.fadeInDuration,
				fadeOutDuration: element.params.fadeOutDuration,
				muted: element.params.muted === true,
				volume: element.params.volume,
			}),
		[
			element.animations,
			element.duration,
			element.params.fadeInDuration,
			element.params.fadeOutDuration,
			element.params.muted,
			element.params.volume,
		],
	);
	if (audioBuffer || audioUrl || sourceFile) {
		return (
			<div className="group/audio relative size-full">
				<MediaElementHeader name={mediaLabel} hasFade={false} />
				<div className="absolute inset-x-0 top-5 bottom-0 overflow-hidden">
					<AudioWaveform
						sourceKey={sourceKey}
						sourceFile={sourceFile}
						audioBuffer={audioBuffer}
						audioUrl={audioUrl}
						gainSamples={gainSamples}
						pixelsPerSecond={pixelsPerSecond}
						clipDurationSec={element.duration / TICKS_PER_SECOND}
						retime={element.retime}
						sourceStartSec={element.trimStart / TICKS_PER_SECOND}
						color={TIMELINE_TRACK_THEME.audio.waveformColor}
					/>
					<AudioVolumeLine element={element} trackId={trackId} />
				</div>
			</div>
		);
	}

	return (
		<div className="group/audio relative size-full">
			<div className="flex size-full items-center pl-2">
				<span className="text-foreground/80 truncate text-xs">
					{element.name}
				</span>
			</div>
			<AudioVolumeLine element={element} trackId={trackId} />
		</div>
	);
}

function EffectsButton({
	element,
	track,
}: {
	element: VideoElement | ImageElement;
	track: TimelineTrack;
}) {
	const editor = useEditor();
	const setActiveTab = usePropertiesStore((s) => s.setActiveTab);

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		editor.selection.setSelectedElements({
			elements: [{ trackId: track.id, elementId: element.id }],
		});
		setActiveTab({ elementType: element.type, tabId: "effects" });
	};

	return (
		<button
			type="button"
			className="flex shrink-0 justify-center text-white cursor-pointer"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={handleClick}
		>
			<HugeiconsIcon icon={MagicWand05Icon} size={12} />
		</button>
	);
}

function TiledMediaContent({
	element,
	track,
	mediaAsset,
}: {
	element: VideoElement | ImageElement;
	track: TimelineTrack;
	mediaAsset: MediaAsset | null;
}) {
	const imageUrl =
		element.type === "video"
			? mediaAsset?.thumbnailUrl
			: (mediaAsset?.thumbnailUrl ?? mediaAsset?.url);

	if (!imageUrl) {
		return (
			<span className="text-foreground/80 truncate text-xs">
				{element.name}
			</span>
		);
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const tileWidth = trackHeight * THUMBNAIL_ASPECT_RATIO;

	return (
		<>
			<div
				className="absolute inset-0"
				style={{
					backgroundColor: "var(--muted)",
					backgroundImage: `url(${imageUrl})`,
					backgroundRepeat: "repeat-x",
					backgroundSize: `${tileWidth}px ${trackHeight}px`,
					backgroundPosition: "left center",
					pointerEvents: "none",
				}}
			/>
			<MediaElementHeader
				name={mediaAsset?.name}
				leading={
					hasElementEffects({ element }) ? (
						<EffectsButton element={element} track={track} />
					) : null
				}
				hasFade={true}
			/>
		</>
	);
}

function MediaElementHeader({
	name,
	leading,
	hasFade,
}: {
	name?: string | null;
	leading?: ReactNode;
	hasFade?: boolean;
}) {
	if (!name && !leading) {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-0 left-0 flex h-5 w-full bg-linear-to-b pt-1",
				hasFade && "from-black/30 to-transparent",
			)}
		>
			{leading && <div className="pl-1">{leading}</div>}
			{name && (
				<span className="truncate px-1.5 text-[0.6rem] leading-tight text-white/75">
					{name}
				</span>
			)}
		</div>
	);
}

function ElementContent({ element, track, mediaAsset }: ElementContentProps) {
	switch (element.type) {
		case "text":
			return <TextElementContent element={element} />;
		case "effect":
			return <EffectElementContent element={element} />;
		case "sticker":
			return <StickerElementContent element={element} />;
		case "graphic":
			return <GraphicElementContent element={element} />;
		case "audio":
			return (
				<AudioElementContent
					element={element}
					trackId={track.id}
					mediaAsset={mediaAsset}
				/>
			);
		case "video":
		case "image":
			return (
				<TiledMediaContent
					element={element}
					track={track}
					mediaAsset={mediaAsset}
				/>
			);
	}
}

function CopyMenuItem() {
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<HugeiconsIcon icon={Copy01Icon} />}
		>
			Copy
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	isMuted: boolean;
}) {
	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={VolumeMute02Icon} />;
		}
		return isMuted ? (
			<HugeiconsIcon icon={VolumeOffIcon} />
		) : (
			<HugeiconsIcon icon={VolumeHighIcon} />
		);
	};

	return (
		<ActionMenuItem action="toggle-elements-muted-selected" icon={getIcon()}>
			{isMuted ? "Unmute" : "Mute"}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	element,
	isMultipleSelected,
	isCurrentElementSelected,
}: {
	element: TimelineElementType;
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
}) {
	const isHidden = canElementBeHidden(element) && element.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentElementSelected) {
			return <HugeiconsIcon icon={ViewOffSlashIcon} />;
		}
		return isHidden ? (
			<HugeiconsIcon icon={ViewIcon} />
		) : (
			<HugeiconsIcon icon={ViewOffSlashIcon} />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-elements-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? "Show" : "Hide"}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentElementSelected,
	elementType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentElementSelected: boolean;
	elementType: TimelineElementType["type"];
	selectedCount: number;
}) {
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<HugeiconsIcon icon={Delete02Icon} />}
		>
			{isMultipleSelected && isCurrentElementSelected
				? `Delete ${selectedCount} elements`
				: `Delete ${elementType === "text" ? "text" : "clip"}`}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onClick" | "textRight"> & {
	action: TActionWithOptionalArgs;
	children: ReactNode;
}) {
	return (
		<ContextMenuItem
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut({ action })}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
