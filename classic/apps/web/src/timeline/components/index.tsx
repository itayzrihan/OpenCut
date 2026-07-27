"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Delete02Icon,
	ArrowDownIcon,
	ArrowUpIcon,
	MagicWand05Icon,
	MusicNote03Icon,
	TaskAdd02Icon,
	TextIcon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { OcShapesIcon, OcVideoIcon } from "@/components/icons";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTimelineZoom } from "@/timeline/hooks/use-timeline-zoom";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useContainerSize } from "@/hooks/use-container-size";
import { mediaTime, mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import type { ElementDragView, DropTarget } from "@/timeline";
import { TimelineTrackContent } from "./timeline-track";
import { TimelinePlayhead } from "./timeline-playhead";
import { SelectionBox } from "@/selection/selection-box";
import { useBoxSelect } from "@/selection/hooks/use-box-select";
import { SnapIndicator } from "./snap-indicator";
import type { SnapPoint } from "@/timeline/snapping";
import type { TimelineTrack } from "@/timeline";
import {
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
	KEYFRAME_LANE_HEIGHT_PX,
} from "./layout";
import { useElementInteraction } from "@/timeline/hooks/element/use-element-interaction";
import {
	canTrackHaveAudio,
	canTrackBeHidden,
	getTimelineZoomMin,
	getTimelinePaddingPx,
	getDisplayTracks,
} from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { getTrackHeight, getTotalTracksHeight } from "./track-layout";
import { SELECTED_TRACK_ROW_CLASS } from "./theme";
import {
	computeTrackExpansionHeight,
	getTrackExpandedRows,
	getPropertyLabel,
	type ExpandedRow,
} from "./expanded-layout";
import { TIMELINE_HORIZONTAL_WHEEL_STEP_PX } from "./interaction";
import { TimelineToolbar } from "./timeline-toolbar";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { useTimelineSeek } from "@/timeline/hooks/use-timeline-seek";
import { useTimelineDragDrop } from "@/timeline/hooks/use-timeline-drag-drop";
import { TimelineRuler } from "./timeline-ruler";
import { DragLine } from "./drag-line";
import {
	TimelineBookmarksRow,
	useBookmarkDrag,
} from "@/timeline/bookmarks/index";
import { useEdgeAutoScroll } from "@/timeline/hooks/use-edge-auto-scroll";
import { useInitialScrollBottom } from "@/timeline/hooks/use-initial-scroll-bottom";
import { useTimelineResize } from "@/timeline/hooks/use-timeline-resize";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { useScrollPosition } from "@/timeline/hooks/use-scroll-position";
import { useTimelinePlayhead } from "@/timeline/hooks/use-timeline-playhead";
import { invokeAction } from "@/actions";
import { resolveTimelineElementIntersections } from "./selection-hit-testing";
import { cn } from "@/utils/ui";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import { getSelectedTimelineRange } from "@/timeline/range-selection";
import { AiRangeDialog } from "@/ai/components/ai-range-dialog";
import {
	CaptionWordTimingTrack,
	getCaptionWordTimingTrackHeightForWords,
} from "./caption-word-timing-track";
import { findCaptionSourceTrack } from "@/subtitles/caption-tracks";
import { TIMELINE_SCROLL_TO_TIME_EVENT } from "@/timeline/focus-event";
import { getVisibleTrackLayouts } from "./visible-track-layouts";
import { getElementVisibilityScrollLeft } from "./visible-elements";
import {
	getTrackIndexByElementId,
	getTrackIndexesForElementIds,
} from "./track-element-index";
import { AiEditTrack, AI_EDIT_TRACK_HEIGHT_PX } from "./ai-edit-track";
import {
	getAiEditTimelineDuration,
	getAiEditTimelineItems,
} from "./ai-edit-track-model";

const TRACKS_CONTAINER_MAX_HEIGHT = 800;
const FALLBACK_CONTAINER_WIDTH = 1000;
const TRACKS_CONTAINER_HEIGHT = { min: 0, max: TRACKS_CONTAINER_MAX_HEIGHT };
const TRACK_VERTICAL_OVERSCAN_PX = 180;
const EMPTY_SELECTED_ELEMENT_IDS: ReadonlySet<string> = new Set();
const EMPTY_AI_EDIT_HISTORY = [] as const;

type TrackLayout = {
	track: TimelineTrack;
	index: number;
	top: number;
	height: number;
	baseHeight: number;
	extraHeight: number;
};

type TrackLabelTimelineActions = {
	toggleTrackMute: ({ trackId }: { trackId: string }) => void;
	toggleTrackVisibility: ({ trackId }: { trackId: string }) => void;
	reorderTrack: ({
		trackId,
		toIndex,
	}: {
		trackId: string;
		toIndex: number;
	}) => void;
};

function getTrackLayouts({
	tracks,
	startTop,
	getTrackExpansionHeight,
}: {
	tracks: TimelineTrack[];
	startTop: number;
	getTrackExpansionHeight: (trackIndex: number) => number;
}): TrackLayout[] {
	let top = startTop;

	return tracks.map((track, index) => {
		const baseHeight = getTrackHeight({ type: track.type });
		const extraHeight = getTrackExpansionHeight(index);
		const height = baseHeight + extraHeight;
		const layout = {
			track,
			index,
			top,
			height,
			baseHeight,
			extraHeight,
		};
		top += height + TIMELINE_TRACK_GAP_PX;
		return layout;
	});
}

function areStringSetsEqual({
	a,
	b,
}: {
	a: ReadonlySet<string>;
	b: ReadonlySet<string>;
}): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const value of b) {
		if (!a.has(value)) {
			return false;
		}
	}
	return true;
}

const TRACK_ICONS: Record<TimelineTrack["type"], ReactNode> = {
	video: <OcVideoIcon className="text-muted-foreground size-4 shrink-0" />,
	text: (
		<HugeiconsIcon
			icon={TextIcon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	audio: (
		<HugeiconsIcon
			icon={MusicNote03Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	graphic: <OcShapesIcon className="text-muted-foreground size-4 shrink-0" />,
	effect: (
		<HugeiconsIcon
			icon={MagicWand05Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
};

export function Timeline() {
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const aiRangeSelection = useTimelineStore((s) => s.aiRangeSelection);
	const startRangeSelection = useTimelineStore((s) => s.startRangeSelection);
	const updateRangeSelection = useTimelineStore((s) => s.updateRangeSelection);
	const completeRangeSelection = useTimelineStore(
		(s) => s.completeRangeSelection,
	);
	const {
		selectedElements,
		clearElementSelection,
		setElementSelection,
		mergeElementsIntoSelection,
	} = useElementSelection();
	const editor = useEditor();
	const timeline = editor.timeline;
	const scene = useEditorTimelineScenes((currentEditor) =>
		currentEditor.scenes.getActiveSceneOrNull(),
	);
	const tracks = useMemo<TimelineTrack[]>(
		() => (scene ? getDisplayTracks({ tracks: scene.tracks }) : []),
		[scene],
	);
	const aiEditHistory = useEditorProject(
		(currentEditor) =>
			currentEditor.project.getActiveOrNull()?.aiEditHistory ??
			EMPTY_AI_EDIT_HISTORY,
	);
	const aiEditItems = useMemo(
		() =>
			getAiEditTimelineItems({
				history: aiEditHistory,
				activeSceneId: scene?.id ?? null,
			}),
		[aiEditHistory, scene?.id],
	);
	const hasAiEditTrack = aiEditItems.length > 0;
	const captionSourceTrack = useMemo(
		() => (scene ? findCaptionSourceTrack({ tracks: scene.tracks }) : null),
		[scene],
	);
	const hasCaptionWordTimingTrack = !!captionSourceTrack;
	const committedWordTimingTrackHeight = captionSourceTrack?.captionSource
		? getCaptionWordTimingTrackHeightForWords({
				words: captionSourceTrack.captionSource.words,
			})
		: 0;
	const captionSourceTrackId = captionSourceTrack?.id ?? null;
	const [measuredWordTimingTrackHeight, setMeasuredWordTimingTrackHeight] =
		useState<{ trackId: string; height: number } | null>(null);
	const currentMeasuredWordTimingTrackHeight =
		measuredWordTimingTrackHeight?.trackId === captionSourceTrackId
			? measuredWordTimingTrackHeight.height
			: null;
	const wordTimingTrackHeight = hasCaptionWordTimingTrack
		? Math.max(
				committedWordTimingTrackHeight,
				currentMeasuredWordTimingTrackHeight ?? 0,
			)
		: 0;
	const wordTimingTrackOffset = hasCaptionWordTimingTrack
		? wordTimingTrackHeight + TIMELINE_TRACK_GAP_PX
		: 0;
	const aiEditTrackOffset = hasAiEditTrack
		? AI_EDIT_TRACK_HEIGHT_PX + TIMELINE_TRACK_GAP_PX
		: 0;
	const virtualTrackOffset = wordTimingTrackOffset + aiEditTrackOffset;
	const tracksTopInsetPx = TIMELINE_CONTENT_TOP_PADDING_PX + virtualTrackOffset;
	const mainTrackId = scene?.tracks.main.id ?? null;
	const seek = (time: MediaTime) => editor.playback.seek({ time });

	const timelineRef = useRef<HTMLDivElement>(null);
	const timelineHeaderRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLDivElement>(null);
	const rulerScrollRef = useRef<HTMLDivElement>(null);
	const tracksContainerRef = useRef<HTMLDivElement>(null);
	const tracksScrollRef = useRef<HTMLDivElement>(null);
	const trackLabelsRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const trackLabelsScrollRef = useRef<HTMLDivElement>(null);
	const rangeLastMouseXRef = useRef(0);

	const [currentSnapPoint, setCurrentSnapPoint] = useState<SnapPoint | null>(
		null,
	);
	const { width: tracksContainerWidth } = useContainerSize({
		containerRef: tracksContainerRef,
	});
	const { height: timelineHeaderHeightValue } = useContainerSize({
		containerRef: timelineHeaderRef,
	});
	const {
		scrollLeft: tracksScrollLeft,
		scrollTop: tracksScrollTop,
		viewportWidth: tracksViewportWidth,
		viewportHeight: tracksViewportHeight,
	} = useScrollPosition({ scrollRef: tracksScrollRef });
	const elementVisibilityScrollLeft = getElementVisibilityScrollLeft({
		scrollLeft: tracksScrollLeft,
	});

	const handleSnapPointChange = useCallback((snapPoint: SnapPoint | null) => {
		setCurrentSnapPoint(snapPoint);
	}, []);

	const timelineDuration = timeline.getTotalDuration() || 0;
	const captionWordTimingDuration = captionSourceTrack?.captionSource?.words
		.length
		? mediaTimeFromSeconds({
				seconds: captionSourceTrack.captionSource.words.reduce(
					(maxEnd, word) => Math.max(maxEnd, word.end),
					0,
				),
			})
		: 0;
	const aiEditTimelineDuration = getAiEditTimelineDuration({
		items: aiEditItems,
	});
	const timelineDisplayDuration = Math.max(
		timelineDuration,
		captionWordTimingDuration,
		aiEditTimelineDuration,
	);
	const containerWidth = tracksContainerWidth || FALLBACK_CONTAINER_WIDTH;
	const minZoomLevel = getTimelineZoomMin({
		duration: timelineDisplayDuration,
		containerWidth,
	});

	const savedViewState = editor.project.getTimelineViewState();

	const { zoomLevel, setZoomLevel, handleWheel, saveScrollPosition } =
		useTimelineZoom({
			containerRef: timelineRef,
			minZoom: minZoomLevel,
			initialZoom: savedViewState?.zoomLevel,
			initialScrollLeft: savedViewState?.scrollLeft,
			initialPlayheadTime: savedViewState?.playheadTime,
			tracksScrollRef,
			rulerScrollRef,
		});
	const { isResizing, handleResizeStart } = useTimelineResize({
		zoomLevel,
		onSnapPointChange: handleSnapPointChange,
	});

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);
	const isRangeSelectionLocked = aiRangeSelection.isTimelineLocked;
	const selectedAiRange = getSelectedTimelineRange(aiRangeSelection);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	// Stable refs so the wheel listener never goes stale
	const setZoomLevelRef = useRef(setZoomLevel);
	useEffect(() => {
		setZoomLevelRef.current = setZoomLevel;
	}, [setZoomLevel]);

	const handleWordTimingTrackHeightChange = useCallback(
		({ height }: { height: number }) => {
			if (!captionSourceTrackId) return;
			setMeasuredWordTimingTrackHeight((previous) =>
				previous?.trackId === captionSourceTrackId && previous.height === height
					? previous
					: { trackId: captionSourceTrackId, height },
			);
		},
		[captionSourceTrackId],
	);

	const saveScrollPositionRef = useRef(saveScrollPosition);
	useEffect(() => {
		saveScrollPositionRef.current = saveScrollPosition;
	}, [saveScrollPosition]);

	const minZoomLevelRef = useRef(minZoomLevel);
	useEffect(() => {
		minZoomLevelRef.current = minZoomLevel;
	}, [minZoomLevel]);

	// Pushes tracks scroll position to the two overflow:hidden followers
	// (ruler and track labels). Called from the wheel handler (before paint,
	// zero lag) and from onScroll on the tracks area (covers scrollbar drag).
	const syncFollowers = useCallback(() => {
		const tracks = tracksScrollRef.current;
		if (!tracks) return;
		if (rulerScrollRef.current) {
			rulerScrollRef.current.scrollLeft = tracks.scrollLeft;
		}
		if (trackLabelsScrollRef.current) {
			trackLabelsScrollRef.current.scrollTop = tracks.scrollTop;
		}
	}, []);

	// Single non-passive capture listener owns all wheel input. Prevents any
	// native scroll or browser zoom from firing inside the timeline.
	useEffect(() => {
		const container = timelineRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (e: WheelEvent) => {
			const isZoom = e.ctrlKey || e.metaKey;

			if (isZoom) {
				e.preventDefault();
				const normalizedDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				pendingZoomDelta += normalizedDelta;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const frameRawDelta = pendingZoomDelta;
						const cappedDelta =
							Math.sign(frameRawDelta) * Math.min(Math.abs(frameRawDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);
						setZoomLevelRef.current((prev) => prev * zoomFactor);
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}
				return;
			}

			const tracks = tracksScrollRef.current;
			if (!tracks) return;

			const isHorizontal =
				e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);

			e.preventDefault();

			if (isHorizontal) {
				const raw =
					Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				const clamped =
					Math.sign(raw) *
					Math.min(Math.abs(raw), TIMELINE_HORIZONTAL_WHEEL_STEP_PX);
				tracks.scrollLeft = Math.max(0, tracks.scrollLeft + clamped);
			} else {
				tracks.scrollTop = Math.max(0, tracks.scrollTop + e.deltaY);
			}

			syncFollowers();
			saveScrollPositionRef.current();
		};

		container.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});
		return () => {
			container.removeEventListener("wheel", onWheel, { capture: true });
			if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
		};
	}, [syncFollowers]);

	useInitialScrollBottom({
		tracksScrollRef,
		trackLabelsScrollRef,
		onAfterScroll: () => saveScrollPositionRef.current(),
		isReady: tracks.length > 0 || hasCaptionWordTimingTrack || hasAiEditTrack,
	});

	useEffect(() => {
		const handleTimelineScrollRequest = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const detail: unknown = event.detail;
			if (!detail || typeof detail !== "object" || !("time" in detail)) {
				return;
			}
			const { time } = detail;
			if (typeof time !== "number") return;

			const tracksViewport = tracksScrollRef.current;
			if (!tracksViewport) return;

			const viewportWidth = tracksViewport.clientWidth || containerWidth;
			const maxScrollLeft = Math.max(
				0,
				tracksViewport.scrollWidth - viewportWidth,
			);
			const targetLeft = timelineTimeToPixels({ time, zoomLevel });
			const nextScrollLeft = Math.max(
				0,
				Math.min(maxScrollLeft, targetLeft - viewportWidth * 0.35),
			);

			tracksViewport.scrollLeft = nextScrollLeft;
			if (rulerScrollRef.current) {
				rulerScrollRef.current.scrollLeft = nextScrollLeft;
			}
			syncFollowers();
			saveScrollPositionRef.current();
		};

		window.addEventListener(
			TIMELINE_SCROLL_TO_TIME_EVENT,
			handleTimelineScrollRequest,
		);
		return () =>
			window.removeEventListener(
				TIMELINE_SCROLL_TO_TIME_EVENT,
				handleTimelineScrollRequest,
			);
	}, [containerWidth, syncFollowers, zoomLevel]);

	const { dragView, handleElementMouseDown, handleElementClick } =
		useElementInteraction({
			zoomLevel,
			tracksContainerRef,
			tracksScrollRef,
			tracksTopInsetPx,
			snappingEnabled,
			onSnapPointChange: handleSnapPointChange,
		});
	const isElementDragging = dragView.kind === "dragging";

	const {
		dragState: bookmarkDragState,
		handleBookmarkMouseDown,
		lastMouseXRef: bookmarkLastMouseXRef,
	} = useBookmarkDrag({
		zoomLevel,
		scrollRef: tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});

	const { handleRulerMouseDown: handlePlayheadRulerMouseDown } =
		useTimelinePlayhead({
			zoomLevel,
			rulerRef,
			rulerScrollRef,
			tracksScrollRef,
			playheadRef,
		});

	const { isDragOver, dropTarget, dragProps } = useTimelineDragDrop({
		containerRef: tracksContainerRef,
		tracksScrollRef,
		tracksTopInsetPx,
		zoomLevel,
	});
	const activeDropTarget =
		dragView.kind === "dragging" ? dragView.dropTarget : dropTarget;
	const showNewTrackDropLine = !!(
		activeDropTarget &&
		activeDropTarget.isNewTrack &&
		!activeDropTarget.targetElement
	);

	const {
		selectionBox,
		handleMouseDown: handleSelectionMouseDown,
		isSelecting,
		shouldIgnoreClick,
	} = useBoxSelect({
		containerRef: tracksContainerRef,
		selectedIds: selectedElements,
		anchorId: null,
		getIsAdditiveSelection: (event) =>
			event.shiftKey || event.ctrlKey || event.metaKey,
		resolveIntersections: ({ startPos, currentPos }) => {
			if (!tracksContainerRef.current) {
				return [];
			}

			return resolveTimelineElementIntersections({
				container: tracksContainerRef.current,
				scrollContainer: tracksScrollRef.current,
				tracks,
				zoomLevel,
				startPos,
				currentPos,
				tracksTopInsetPx,
				getTrackExtraHeight: getTrackExpansionHeight,
			});
		},
		onSelectionChange: ({ intersectedIds, isAdditive }) => {
			if (isAdditive) {
				mergeElementsIntoSelection({ elements: intersectedIds });
			} else {
				setElementSelection({ elements: intersectedIds });
			}
		},
		isEnabled: !isRangeSelectionLocked,
	});

	const contentWidth = timelineTimeToPixels({
		time: timelineDisplayDuration,
		zoomLevel,
	});
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom: minZoomLevel,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx,
		containerWidth,
	);
	const hasHorizontalScrollbar =
		dynamicTimelineWidth > (tracksViewportWidth || containerWidth);

	useEdgeAutoScroll({
		isActive: bookmarkDragState.isDragging,
		getMouseClientX: () => bookmarkLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	useEdgeAutoScroll({
		isActive: isElementDragging,
		getMouseClientX: () =>
			dragView.kind === "dragging" ? dragView.currentMouseX : 0,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	useEdgeAutoScroll({
		isActive: aiRangeSelection.mode === "selecting",
		getMouseClientX: () => rangeLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	const showSnapIndicator =
		snappingEnabled &&
		currentSnapPoint !== null &&
		(isElementDragging || bookmarkDragState.isDragging || isResizing);

	const {
		handleTracksMouseDown,
		handleTracksClick,
		handleRulerMouseDown,
		handleRulerClick,
	} = useTimelineSeek({
		playheadRef,
		trackLabelsRef,
		rulerScrollRef,
		tracksScrollRef,
		zoomLevel,
		duration: timeline.getTotalDuration(),
		isSelecting,
		clearSelectedElements: clearElementSelection,
		seek,
	});

	const timelineHeaderHeight =
		timelineHeaderHeightValue + TIMELINE_CONTENT_TOP_PADDING_PX;
	const tracksAreaHeight =
		Math.max(
			TRACKS_CONTAINER_HEIGHT.min,
			Math.min(
				TRACKS_CONTAINER_HEIGHT.max,
				getTotalTracksHeight({
					tracks,
					getExtraHeight: getTrackExpansionHeight,
				}) + virtualTrackOffset,
			),
		) + TIMELINE_CONTENT_TOP_PADDING_PX;

	const getRangeTimeFromClientX = useCallback(
		(clientX: number) => {
			const container = tracksContainerRef.current;
			if (!container) {
				return null;
			}
			return getMouseTimeFromClientX({
				clientX,
				containerRect: container.getBoundingClientRect(),
				zoomLevel,
				scrollLeft:
					tracksScrollRef.current?.scrollLeft ??
					rulerScrollRef.current?.scrollLeft ??
					0,
			});
		},
		[zoomLevel],
	);

	const handleRangeSelectionMouseDown = useCallback(
		(event: React.MouseEvent) => {
			const state = useTimelineStore.getState().aiRangeSelection;
			if (!state.isTimelineLocked) {
				return false;
			}
			event.preventDefault();
			event.stopPropagation();
			if (event.button !== 0) {
				return true;
			}

			const startTime = getRangeTimeFromClientX(event.clientX);
			if (startTime === null) {
				return true;
			}

			rangeLastMouseXRef.current = event.clientX;
			startRangeSelection(startTime);

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const nextTime = getRangeTimeFromClientX(moveEvent.clientX);
				if (nextTime === null) return;
				rangeLastMouseXRef.current = moveEvent.clientX;
				updateRangeSelection(nextTime);
			};
			const handleMouseUp = (upEvent: MouseEvent) => {
				const nextTime = getRangeTimeFromClientX(upEvent.clientX);
				if (nextTime !== null) {
					completeRangeSelection(nextTime);
				}
				window.removeEventListener("mousemove", handleMouseMove);
				window.removeEventListener("mouseup", handleMouseUp);
			};

			window.addEventListener("mousemove", handleMouseMove);
			window.addEventListener("mouseup", handleMouseUp);
			return true;
		},
		[
			completeRangeSelection,
			getRangeTimeFromClientX,
			startRangeSelection,
			updateRangeSelection,
		],
	);
	const handleTimelineTrackResizeStart = useCallback<
		React.ComponentProps<typeof TimelineTrackContent>["onResizeStart"]
	>(
		(params) => {
			if (handleRangeSelectionMouseDown(params.event)) return;
			handleResizeStart(params);
		},
		[handleRangeSelectionMouseDown, handleResizeStart],
	);
	const handleTimelineElementMouseDown = useCallback<
		React.ComponentProps<typeof TimelineTrackContent>["onElementMouseDown"]
	>(
		(params) => {
			if (handleRangeSelectionMouseDown(params.event)) return;
			handleElementMouseDown(params);
		},
		[handleElementMouseDown, handleRangeSelectionMouseDown],
	);
	const handleTimelineElementClick = useCallback<
		React.ComponentProps<typeof TimelineTrackContent>["onElementClick"]
	>(
		(params) => {
			if (isRangeSelectionLocked) {
				params.event.preventDefault();
				params.event.stopPropagation();
				return;
			}
			handleElementClick(params);
		},
		[handleElementClick, isRangeSelectionLocked],
	);
	const handleTimelineTrackMouseDown = useCallback(
		(event: React.MouseEvent) => {
			if (handleRangeSelectionMouseDown(event)) return;
			handleSelectionMouseDown(event);
			handleTracksMouseDown(event);
		},
		[
			handleRangeSelectionMouseDown,
			handleSelectionMouseDown,
			handleTracksMouseDown,
		],
	);
	const handleTimelineTrackMouseUp = useCallback(
		(event: React.MouseEvent) => {
			if (isRangeSelectionLocked) return;
			handleTracksClick(event);
		},
		[handleTracksClick, isRangeSelectionLocked],
	);

	return (
		<section
			className={
				"panel bg-background relative flex h-full flex-col overflow-hidden rounded-sm border"
			}
			{...dragProps}
			aria-label="Timeline"
		>
			<TimelineToolbar
				zoomLevel={zoomLevel}
				minZoom={minZoomLevel}
				setZoomLevel={({ zoom }) => setZoomLevel(zoom)}
			/>

			<div className="relative flex flex-1 overflow-hidden" ref={timelineRef}>
				<TrackLabelsPanel
					trackLabelsRef={trackLabelsRef}
					trackLabelsScrollRef={trackLabelsScrollRef}
					timelineHeaderHeight={timelineHeaderHeight}
					hasHorizontalScrollbar={hasHorizontalScrollbar}
					getTrackExpansionHeight={getTrackExpansionHeight}
					wordTimingTrackHeight={wordTimingTrackHeight}
					aiEditTrackHeight={hasAiEditTrack ? AI_EDIT_TRACK_HEIGHT_PX : 0}
					aiEditItemCount={aiEditItems.length}
					scrollTop={tracksScrollTop}
					viewportHeight={tracksViewportHeight}
				/>

				<div
					className={cn(
						"relative isolate flex flex-1 flex-col overflow-hidden",
						isRangeSelectionLocked && "cursor-crosshair",
					)}
					ref={tracksContainerRef}
				>
					<SelectionBox
						bounds={
							!isRangeSelectionLocked ? (selectionBox?.bounds ?? null) : null
						}
					/>
					<div ref={rulerScrollRef} className="shrink-0 overflow-hidden">
						<div
							ref={timelineHeaderRef}
							className="flex flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							<TimelineRuler
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								scrollLeft={tracksScrollLeft}
								viewportWidth={tracksViewportWidth}
								rulerRef={rulerRef}
								handleWheel={handleWheel}
								handleTimelineContentClick={(event) => {
									if (isRangeSelectionLocked) return;
									handleRulerClick(event);
								}}
								handleRulerTrackingMouseDown={(event) => {
									if (handleRangeSelectionMouseDown(event)) return;
									handleRulerMouseDown(event);
								}}
								handleRulerMouseDown={(event) => {
									if (isRangeSelectionLocked) {
										event.preventDefault();
										event.stopPropagation();
										return;
									}
									handlePlayheadRulerMouseDown(event);
								}}
							/>
							<TimelineBookmarksRow
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								scrollLeft={tracksScrollLeft}
								viewportWidth={tracksViewportWidth}
								dragState={bookmarkDragState}
								onBookmarkMouseDown={handleBookmarkMouseDown}
								handleWheel={handleWheel}
								handleTimelineContentClick={(event) => {
									if (isRangeSelectionLocked) return;
									handleRulerClick(event);
								}}
								handleRulerTrackingMouseDown={(event) => {
									if (handleRangeSelectionMouseDown(event)) return;
									handleRulerMouseDown(event);
								}}
								handleRulerMouseDown={(event) => {
									if (isRangeSelectionLocked) {
										event.preventDefault();
										event.stopPropagation();
										return;
									}
									handlePlayheadRulerMouseDown(event);
								}}
							/>
						</div>
					</div>

					<ScrollArea
						className="flex-1"
						ref={tracksScrollRef}
						onScroll={() => {
							syncFollowers();
							saveScrollPosition();
						}}
					>
						<div
							className="flex min-h-full flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							{/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (tracks container background); direct-target clicks here originate box-select or clear selection. Keyboard control is global timeline shortcuts. */}
							<div
								className="relative shrink-0"
								style={{
									height: `${tracksAreaHeight}px`,
								}}
								onMouseDown={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									if (handleRangeSelectionMouseDown(event)) return;
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									if (isRangeSelectionLocked) return;
									handleTracksClick(event);
								}}
							>
								<TimelineRangeOverlay
									range={selectedAiRange}
									zoomLevel={zoomLevel}
									height={tracksAreaHeight}
									mode={aiRangeSelection.mode}
								/>
								{hasCaptionWordTimingTrack && (
									<div
										className="absolute right-0 left-0"
										style={{ top: `${TIMELINE_CONTENT_TOP_PADDING_PX}px` }}
									>
										<CaptionWordTimingTrack
											zoomLevel={zoomLevel}
											dynamicTimelineWidth={dynamicTimelineWidth}
											scrollLeft={elementVisibilityScrollLeft}
											viewportWidth={tracksViewportWidth}
											onHeightChange={handleWordTimingTrackHeightChange}
											onMouseDown={handleTimelineTrackMouseDown}
											onMouseUp={handleTimelineTrackMouseUp}
										/>
									</div>
								)}
								{hasAiEditTrack && (
									<div
										className="absolute right-0 left-0"
										style={{
											top: `${
												TIMELINE_CONTENT_TOP_PADDING_PX + wordTimingTrackOffset
											}px`,
										}}
									>
										<AiEditTrack
											items={aiEditItems}
											zoomLevel={zoomLevel}
											dynamicTimelineWidth={dynamicTimelineWidth}
											scrollLeft={elementVisibilityScrollLeft}
											viewportWidth={tracksViewportWidth}
											interactionDisabled={isRangeSelectionLocked}
											onSeek={seek}
											onMouseDown={handleTimelineTrackMouseDown}
											onMouseUp={handleTimelineTrackMouseUp}
										/>
									</div>
								)}
								{tracks.length > 0 && (
									<TimelineTrackRows
										mainTrackId={mainTrackId}
										zoomLevel={zoomLevel}
										topOffset={virtualTrackOffset}
										scrollLeft={elementVisibilityScrollLeft}
										scrollTop={tracksScrollTop}
										viewportWidth={tracksViewportWidth}
										viewportHeight={tracksViewportHeight}
										dragView={dragView}
										onResizeStart={handleTimelineTrackResizeStart}
										onElementMouseDown={handleTimelineElementMouseDown}
										onElementClick={handleTimelineElementClick}
										onTrackMouseDown={handleTimelineTrackMouseDown}
										onTrackMouseUp={handleTimelineTrackMouseUp}
										shouldIgnoreClick={shouldIgnoreClick}
										isDragOver={isDragOver}
										dropTarget={dropTarget}
									/>
								)}
								<DragLine
									dropTarget={activeDropTarget}
									tracks={tracks}
									isVisible={showNewTrackDropLine}
									headerHeight={tracksTopInsetPx}
								/>
							</div>
							<TimelineGutter
								onMouseDown={(event) => {
									if (handleRangeSelectionMouseDown(event)) return;
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={(event) => {
									if (isRangeSelectionLocked) return;
									handleTracksClick(event);
								}}
							/>
						</div>
					</ScrollArea>

					<TimelinePlayhead
						zoomLevel={zoomLevel}
						hasHorizontalScrollbar={hasHorizontalScrollbar}
						rulerRef={rulerRef}
						rulerScrollRef={rulerScrollRef}
						tracksScrollRef={tracksScrollRef}
						timelineRef={timelineRef}
						playheadRef={playheadRef}
						isSnappingToPlayhead={
							showSnapIndicator && currentSnapPoint?.type === "playhead"
						}
					/>
				</div>
				<SnapIndicator
					snapPoint={currentSnapPoint}
					zoomLevel={zoomLevel}
					scrollLeft={tracksScrollLeft}
					timelineRef={timelineRef}
					isVisible={showSnapIndicator}
				/>
			</div>
			<AiRangeDialog />
		</section>
	);
}

function TimelineRangeOverlay({
	range,
	zoomLevel,
	height,
	mode,
}: {
	range: ReturnType<typeof getSelectedTimelineRange>;
	zoomLevel: number;
	height: number;
	mode: string;
}) {
	if (!range) {
		return null;
	}

	const left = timelineTimeToPixels({ time: range.startTime, zoomLevel });
	const right = timelineTimeToPixels({ time: range.endTime, zoomLevel });
	const width = Math.max(1, right - left);

	return (
		<div
			className="pointer-events-none absolute top-0 z-40 border-x border-primary/80 bg-primary/12"
			style={{
				left,
				width,
				height,
			}}
			data-ai-range-mode={mode}
		>
			<div className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
			<div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/60" />
		</div>
	);
}

function TrackLabelsPanel({
	trackLabelsRef,
	trackLabelsScrollRef,
	timelineHeaderHeight,
	hasHorizontalScrollbar,
	getTrackExpansionHeight,
	wordTimingTrackHeight,
	aiEditTrackHeight,
	aiEditItemCount,
	scrollTop,
	viewportHeight,
}: {
	trackLabelsRef: React.RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineHeaderHeight: number;
	hasHorizontalScrollbar: boolean;
	getTrackExpansionHeight: (trackIndex: number) => number;
	wordTimingTrackHeight: number;
	aiEditTrackHeight: number;
	aiEditItemCount: number;
	scrollTop: number;
	viewportHeight: number;
}) {
	const [timeline, scene] = useEditorTimelineScenes((e) => [
		e.timeline,
		e.scenes.getActiveSceneOrNull(),
	]);
	const tracks = useMemo<TimelineTrack[]>(
		() => (scene ? getDisplayTracks({ tracks: scene.tracks }) : []),
		[scene],
	);
	const hasCaptionWordTimingTrack = !!(
		scene && findCaptionSourceTrack({ tracks: scene.tracks })
	);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);
	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);
	const trackExpandedRowsMap = useMemo(
		() =>
			tracks.map((track) =>
				getTrackExpandedRows({ track, expandedElementIds }),
			),
		[tracks, expandedElementIds],
	);
	const wordTimingTrackOffset = hasCaptionWordTimingTrack
		? wordTimingTrackHeight + TIMELINE_TRACK_GAP_PX
		: 0;
	const hasAiEditTrack = aiEditTrackHeight > 0 && aiEditItemCount > 0;
	const aiEditTrackOffset = hasAiEditTrack
		? aiEditTrackHeight + TIMELINE_TRACK_GAP_PX
		: 0;
	const labelTrackStartTop = wordTimingTrackOffset + aiEditTrackOffset;
	const trackLayouts = useMemo(
		() =>
			getTrackLayouts({
				tracks,
				startTop: labelTrackStartTop,
				getTrackExpansionHeight,
			}),
		[tracks, labelTrackStartTop, getTrackExpansionHeight],
	);
	const visibleTrackLayouts = useMemo(
		() =>
			getVisibleTrackLayouts({
				layouts: trackLayouts,
				scrollTop,
				viewportHeight,
				overscanPx: TRACK_VERTICAL_OVERSCAN_PX,
			}),
		[scrollTop, trackLayouts, viewportHeight],
	);
	const labelContentHeight =
		trackLayouts.length > 0
			? trackLayouts[trackLayouts.length - 1].top +
				trackLayouts[trackLayouts.length - 1].height
			: labelTrackStartTop;

	return (
		<div
			className="flex shrink-0 flex-col border-r"
			style={{ width: `${TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX}px` }}
		>
			<div
				className="shrink-0"
				style={{ height: timelineHeaderHeight || 48 }}
			/>
			<div ref={trackLabelsRef} className="flex-1 overflow-hidden">
				<div ref={trackLabelsScrollRef} className="size-full overflow-hidden">
					{(tracks.length > 0 ||
						hasCaptionWordTimingTrack ||
						hasAiEditTrack) && (
						<div
							className="relative"
							style={{ height: `${labelContentHeight}px` }}
						>
							{hasCaptionWordTimingTrack && (
								<div
									className="absolute right-0 left-0 flex items-center justify-end border-b border-red-500/20 bg-red-950/10 px-3"
									style={{
										top: 0,
										height: `${wordTimingTrackHeight}px`,
									}}
								>
									<span className="truncate text-xs font-medium text-red-200/80">
										Words
									</span>
								</div>
							)}
							{hasAiEditTrack && (
								<div
									className="absolute right-0 left-0 flex items-center justify-end border-b border-violet-400/20 bg-violet-950/10 px-3"
									style={{
										top: `${wordTimingTrackOffset}px`,
										height: `${aiEditTrackHeight}px`,
									}}
									title={`${aiEditItemCount} persisted AI edit ${
										aiEditItemCount === 1 ? "layer" : "layers"
									}`}
								>
									<span className="truncate text-xs font-medium text-violet-200/80">
										AI edits
									</span>
								</div>
							)}
							{visibleTrackLayouts.map((layout) => {
								return (
									<TrackLabelRow
										key={layout.track.id}
										layout={layout}
										expandedRows={trackExpandedRowsMap[layout.index]}
										isSelected={tracksWithSelection.has(layout.track.id)}
										isLastTrack={layout.index === tracks.length - 1}
										timeline={timeline}
									/>
								);
							})}
						</div>
					)}
				</div>
			</div>
			<div
				className="bg-background shrink-0"
				style={{
					height: hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX : 0,
				}}
			/>
		</div>
	);
}

function TimelineTrackRows({
	mainTrackId,
	zoomLevel,
	topOffset,
	scrollLeft,
	scrollTop,
	viewportWidth,
	viewportHeight,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	isDragOver,
	dropTarget,
}: {
	mainTrackId: string | null;
	zoomLevel: number;
	topOffset: number;
	scrollLeft: number;
	scrollTop: number;
	viewportWidth: number;
	viewportHeight: number;
	dragView: ElementDragView;
	onResizeStart: React.ComponentProps<
		typeof TimelineTrackContent
	>["onResizeStart"];
	onElementMouseDown: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementMouseDown"];
	onElementClick: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementClick"];
	onTrackMouseDown: (event: React.MouseEvent) => void;
	onTrackMouseUp: (event: React.MouseEvent) => void;
	shouldIgnoreClick: () => boolean;
	isDragOver: boolean;
	dropTarget: DropTarget | null;
}) {
	const [timeline, renderSceneTracks] = useEditorTimelineScenes((e) => [
		e.timeline,
		e.timeline.getPreviewTracks() ??
			e.scenes.getActiveSceneOrNull()?.tracks ??
			null,
	]);
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			renderSceneTracks ? getDisplayTracks({ tracks: renderSceneTracks }) : [],
		[renderSceneTracks],
	);
	const trackIndexByElementId = useMemo(
		() => getTrackIndexByElementId({ tracks }),
		[tracks],
	);
	const { selectedElements } = useElementSelection();
	const selectedElementIdsByTrack = useMemo(() => {
		const idsByTrack = new Map<string, Set<string>>();
		for (const selectedElement of selectedElements) {
			const trackSelection =
				idsByTrack.get(selectedElement.trackId) ?? new Set<string>();
			trackSelection.add(selectedElement.elementId);
			idsByTrack.set(selectedElement.trackId, trackSelection);
		}
		return idsByTrack;
	}, [selectedElements]);
	const hoveredTrackIndex =
		dragView.kind === "dragging" && dragView.dropTarget?.isNewTrack === false
			? dragView.dropTarget.trackIndex
			: isDragOver && dropTarget?.isNewTrack === false
				? dropTarget.trackIndex
				: null;

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	const draggingElementIds = useMemo(
		() =>
			dragView.kind === "dragging"
				? dragView.memberTimeOffsets
				: (null as ReadonlyMap<string, MediaTime> | null),
		[dragView],
	);
	const draggedTrackIndexes = useMemo(
		() =>
			draggingElementIds
				? getTrackIndexesForElementIds({
						elementIds: draggingElementIds.keys(),
						trackIndexByElementId,
					})
				: null,
		[draggingElementIds, trackIndexByElementId],
	);
	const trackLayouts = useMemo(
		() =>
			getTrackLayouts({
				tracks,
				startTop: TIMELINE_CONTENT_TOP_PADDING_PX + topOffset,
				getTrackExpansionHeight,
			}),
		[tracks, topOffset, getTrackExpansionHeight],
	);
	const forcedTrackIndexes = useMemo(() => {
		const indexes = new Set<number>(draggedTrackIndexes ?? []);
		if (hoveredTrackIndex !== null) {
			indexes.add(hoveredTrackIndex);
		}
		return indexes;
	}, [draggedTrackIndexes, hoveredTrackIndex]);
	const visibleTrackLayouts = useMemo(
		() =>
			getVisibleTrackLayouts({
				layouts: trackLayouts,
				scrollTop,
				viewportHeight,
				overscanPx: TRACK_VERTICAL_OVERSCAN_PX,
				forcedIndexes: forcedTrackIndexes,
			}),
		[forcedTrackIndexes, scrollTop, trackLayouts, viewportHeight],
	);
	const sortedTrackLayouts = useMemo(() => {
		if (!draggedTrackIndexes) return visibleTrackLayouts;
		return [...visibleTrackLayouts].sort((a, b) => {
			const aHasDragged = draggedTrackIndexes.has(a.index);
			const bHasDragged = draggedTrackIndexes.has(b.index);
			if (aHasDragged) return 1;
			if (bHasDragged) return -1;
			return 0;
		});
	}, [draggedTrackIndexes, visibleTrackLayouts]);

	return (
		<>
			{sortedTrackLayouts.map((layout) => {
				const { track, index } = layout;
				return (
					<TimelineTrackRow
						key={track.id}
						layout={layout}
						mainTrackId={mainTrackId}
						zoomLevel={zoomLevel}
						scrollLeft={scrollLeft}
						viewportWidth={viewportWidth}
						dragView={dragView}
						onResizeStart={onResizeStart}
						onElementMouseDown={onElementMouseDown}
						onElementClick={onElementClick}
						onTrackMouseDown={onTrackMouseDown}
						onTrackMouseUp={onTrackMouseUp}
						shouldIgnoreClick={shouldIgnoreClick}
						isSelected={selectedElementIdsByTrack.has(track.id)}
						isHovered={hoveredTrackIndex === index}
						timeline={timeline}
						selectedElementIds={
							selectedElementIdsByTrack.get(track.id) ??
							EMPTY_SELECTED_ELEMENT_IDS
						}
						expandedElementIds={expandedElementIds}
						targetElementId={
							isDragOver ? (dropTarget?.targetElement?.elementId ?? null) : null
						}
					/>
				);
			})}
		</>
	);
}

type TimelineTrackRowProps = {
	layout: TrackLayout;
	mainTrackId: string | null;
	zoomLevel: number;
	scrollLeft: number;
	viewportWidth: number;
	dragView: ElementDragView;
	onResizeStart: React.ComponentProps<
		typeof TimelineTrackContent
	>["onResizeStart"];
	onElementMouseDown: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementMouseDown"];
	onElementClick: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementClick"];
	onTrackMouseDown: (event: React.MouseEvent) => void;
	onTrackMouseUp: (event: React.MouseEvent) => void;
	shouldIgnoreClick: () => boolean;
	isSelected: boolean;
	isHovered: boolean;
	timeline: TrackLabelTimelineActions & {
		removeTrack: ({ trackId }: { trackId: string }) => void;
		closeGap: ({
			startTime,
			endTime,
		}: {
			startTime: MediaTime;
			endTime: MediaTime;
		}) => void;
	};
	selectedElementIds: ReadonlySet<string>;
	expandedElementIds: ReadonlySet<string>;
	targetElementId: string | null;
};

function TimelineTrackRowComponent({
	layout,
	mainTrackId,
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
	isSelected,
	isHovered,
	timeline,
	selectedElementIds,
	expandedElementIds,
	targetElementId,
}: TimelineTrackRowProps) {
	const { track } = layout;
	const [contextTime, setContextTime] = useState<MediaTime | null>(null);
	const clickedGap = useMemo(() => {
		if (track.id !== mainTrackId || contextTime === null) return null;
		const elements = [...track.elements].sort(
			(a, b) => a.startTime - b.startTime,
		);
		const previous = elements
			.filter((element) => element.startTime + element.duration <= contextTime)
			.at(-1);
		const next = elements.find((element) => element.startTime >= contextTime);
		if (!previous || !next) return null;
		const startTime = mediaTime({
			ticks: previous.startTime + previous.duration,
		});
		const endTime = next.startTime;
		return endTime > startTime &&
			contextTime >= startTime &&
			contextTime <= endTime
			? { startTime, endTime }
			: null;
	}, [contextTime, mainTrackId, track]);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					onContextMenu={(event) => {
						const rect = event.currentTarget.getBoundingClientRect();
						const seconds =
							(event.clientX - rect.left + scrollLeft) /
							getTimelinePixelsPerSecond({ zoomLevel });
						setContextTime(mediaTimeFromSeconds({ seconds }));
					}}
					className={cn(
						"absolute right-0 left-0 transition-colors",
						isSelected && SELECTED_TRACK_ROW_CLASS,
						isHovered && "bg-primary/10 ring-1 ring-primary/35",
					)}
					style={{
						top: `${layout.top}px`,
						height: `${layout.height}px`,
					}}
				>
					<TimelineTrackContent
						track={track}
						zoomLevel={zoomLevel}
						scrollLeft={scrollLeft}
						viewportWidth={viewportWidth}
						dragView={dragView}
						onResizeStart={onResizeStart}
						onElementMouseDown={onElementMouseDown}
						onElementClick={onElementClick}
						onTrackMouseDown={onTrackMouseDown}
						onTrackMouseUp={onTrackMouseUp}
						shouldIgnoreClick={shouldIgnoreClick}
						selectedElementIds={selectedElementIds}
						expandedElementIds={expandedElementIds}
						targetElementId={targetElementId}
					/>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-40">
				{clickedGap && (
					<ContextMenuItem onClick={() => timeline.closeGap(clickedGap)}>
						Close gap on all layers
					</ContextMenuItem>
				)}
				<ContextMenuItem
					icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
					onClick={(event: React.MouseEvent) => {
						event.stopPropagation();
						invokeAction("paste-copied");
					}}
				>
					Paste elements
				</ContextMenuItem>
				{canTrackHaveAudio(track) && (
					<ContextMenuItem
						icon={<HugeiconsIcon icon={VolumeHighIcon} />}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							timeline.toggleTrackMute({ trackId: track.id });
						}}
					>
						{track.muted ? "Unmute track" : "Mute track"}
					</ContextMenuItem>
				)}
				{canTrackBeHidden(track) && (
					<ContextMenuItem
						icon={<HugeiconsIcon icon={ViewIcon} />}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							timeline.toggleTrackVisibility({ trackId: track.id });
						}}
					>
						{track.hidden ? "Show track" : "Hide track"}
					</ContextMenuItem>
				)}
				{track.id !== mainTrackId && (
					<ContextMenuItem
						icon={<HugeiconsIcon icon={Delete02Icon} />}
						onClick={(event: React.MouseEvent) => {
							event.stopPropagation();
							timeline.removeTrack({ trackId: track.id });
						}}
						variant="destructive"
					>
						Delete track
					</ContextMenuItem>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

function areTimelineTrackRowPropsEqual({
	previous,
	next,
}: {
	previous: TimelineTrackRowProps;
	next: TimelineTrackRowProps;
}): boolean {
	return (
		previous.layout === next.layout &&
		previous.mainTrackId === next.mainTrackId &&
		previous.zoomLevel === next.zoomLevel &&
		previous.scrollLeft === next.scrollLeft &&
		previous.viewportWidth === next.viewportWidth &&
		previous.dragView === next.dragView &&
		previous.onResizeStart === next.onResizeStart &&
		previous.onElementMouseDown === next.onElementMouseDown &&
		previous.onElementClick === next.onElementClick &&
		previous.onTrackMouseDown === next.onTrackMouseDown &&
		previous.onTrackMouseUp === next.onTrackMouseUp &&
		previous.shouldIgnoreClick === next.shouldIgnoreClick &&
		previous.isSelected === next.isSelected &&
		previous.isHovered === next.isHovered &&
		previous.timeline === next.timeline &&
		areStringSetsEqual({
			a: previous.selectedElementIds,
			b: next.selectedElementIds,
		}) &&
		previous.expandedElementIds === next.expandedElementIds &&
		previous.targetElementId === next.targetElementId
	);
}

const TimelineTrackRow = memo(TimelineTrackRowComponent, (previous, next) =>
	areTimelineTrackRowPropsEqual({ previous, next }),
);
TimelineTrackRow.displayName = "TimelineTrackRow";

function TimelineGutter({
	onMouseDown,
	onClick,
}: {
	onMouseDown: (event: React.MouseEvent) => void;
	onClick: (event: React.MouseEvent) => void;
}) {
	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (empty space below tracks); clicks here clear selection. Keyboard control is global timeline shortcuts.
		<div className="flex-1" onMouseDown={onMouseDown} onClick={onClick} />
	);
}

function TrackIcon({ track }: { track: TimelineTrack }) {
	return <>{TRACK_ICONS[track.type]}</>;
}

const TrackLabelRow = memo(function TrackLabelRow({
	layout,
	expandedRows,
	isSelected,
	isLastTrack,
	timeline,
}: {
	layout: TrackLayout;
	expandedRows: ExpandedRow[];
	isSelected: boolean;
	isLastTrack: boolean;
	timeline: TrackLabelTimelineActions;
}) {
	const { track, index } = layout;

	return (
		<div
			className={cn(
				"group absolute right-0 left-0 flex flex-col",
				isSelected && SELECTED_TRACK_ROW_CLASS,
			)}
			style={{
				top: `${layout.top}px`,
				height: `${layout.height}px`,
			}}
		>
			<div
				className="flex shrink-0 items-center justify-end gap-2 px-3"
				style={{ height: `${layout.baseHeight}px` }}
			>
				{canTrackHaveAudio(track) && (
					<TrackToggleIcon
						isOff={track.muted}
						icons={{
							on: VolumeHighIcon,
							off: VolumeOffIcon,
						}}
						onClick={() =>
							timeline.toggleTrackMute({
								trackId: track.id,
							})
						}
					/>
				)}
				{canTrackBeHidden(track) && (
					<TrackToggleIcon
						isOff={track.hidden}
						icons={{
							on: ViewIcon,
							off: ViewOffSlashIcon,
						}}
						onClick={() =>
							timeline.toggleTrackVisibility({
								trackId: track.id,
							})
						}
					/>
				)}
				<TrackToggleIcon
					isOff={index === 0}
					icons={{
						on: ArrowUpIcon,
						off: ArrowUpIcon,
					}}
					destructiveOff={false}
					onClick={() => {
						if (index > 0) {
							timeline.reorderTrack({
								trackId: track.id,
								toIndex: index - 1,
							});
						}
					}}
				/>
				<TrackToggleIcon
					isOff={isLastTrack}
					icons={{
						on: ArrowDownIcon,
						off: ArrowDownIcon,
					}}
					destructiveOff={false}
					onClick={() => {
						if (!isLastTrack) {
							timeline.reorderTrack({
								trackId: track.id,
								toIndex: index + 1,
							});
						}
					}}
				/>
				<TrackIcon track={track} />
			</div>
			{expandedRows.length > 0 && <PropertyTree rows={expandedRows} />}
		</div>
	);
});
TrackLabelRow.displayName = "TrackLabelRow";

function TrackToggleIcon({
	isOff,
	icons,
	onClick,
	destructiveOff = true,
}: {
	isOff: boolean;
	icons: {
		on: IconSvgElement;
		off: IconSvgElement;
	};
	onClick: () => void;
	destructiveOff?: boolean;
}) {
	return (
		<>
			{isOff ? (
				<HugeiconsIcon
					icon={icons.off}
					className={cn(
						"size-4 cursor-pointer",
						destructiveOff ? "text-destructive" : "text-muted-foreground/35",
					)}
					onClick={onClick}
				/>
			) : (
				<HugeiconsIcon
					icon={icons.on}
					className="text-muted-foreground size-4 cursor-pointer"
					onClick={onClick}
				/>
			)}
		</>
	);
}

function PropertyTree({ rows }: { rows: ExpandedRow[] }) {
	return (
		<div className="flex flex-col overflow-hidden">
			{rows.map((row) => (
				<div
					key={row.propertyPath}
					className={cn("flex shrink-0 items-center px-3 bg-muted/50")}
					style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
				>
					<span className="text-muted-foreground truncate text-xs leading-none">
						{getPropertyLabel(row.propertyPath)}
					</span>
				</div>
			))}
		</div>
	);
}
