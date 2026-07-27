import { memo, useMemo } from "react";
import type { MediaTime } from "@/wasm";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { cn } from "@/utils/ui";
import type { AiEditTimelineItem } from "./ai-edit-track-model";

export const AI_EDIT_TRACK_HEIGHT_PX = 34;

const AI_EDIT_ITEM_HEIGHT_PX = 13;
const AI_EDIT_ITEM_VERTICAL_GAP_PX = 2;
const AI_EDIT_MIN_RANGE_WIDTH_PX = 16;
const AI_EDIT_MARKER_WIDTH_PX = 11;
const AI_EDIT_HORIZONTAL_OVERSCAN_PX = 200;
const AI_EDIT_VISUAL_LANES = 2;

interface AiEditItemLayout {
	item: AiEditTimelineItem;
	left: number;
	width: number;
	top: number;
	index: number;
}

function getItemTitle(item: AiEditTimelineItem): string {
	const activity =
		item.operationCount > 1
			? `${item.operationCount} operations`
			: item.operationType.replaceAll(/[_-]+/g, " ");
	return [item.planTitle, item.label, activity, item.reason]
		.filter(Boolean)
		.join(" · ");
}

function buildLayouts({
	items,
	zoomLevel,
}: {
	items: readonly AiEditTimelineItem[];
	zoomLevel: number;
}): AiEditItemLayout[] {
	let projectMarkerIndex = 0;
	return items.map((item, index) => {
		let left: number;
		let width: number;
		if (item.anchor.kind === "range") {
			left = timelineTimeToPixels({
				time: item.anchor.startTime,
				zoomLevel,
			});
			width = Math.max(
				AI_EDIT_MIN_RANGE_WIDTH_PX,
				timelineTimeToPixels({
					time: item.anchor.duration,
					zoomLevel,
				}),
			);
		} else if (item.anchor.kind === "point") {
			const center = timelineTimeToPixels({
				time: item.anchor.time,
				zoomLevel,
			});
			left = Math.max(0, center - AI_EDIT_MARKER_WIDTH_PX / 2);
			width = AI_EDIT_MARKER_WIDTH_PX;
		} else {
			left = 3 + (projectMarkerIndex % 8) * 3;
			width = AI_EDIT_MARKER_WIDTH_PX;
			projectMarkerIndex += 1;
		}

		return {
			item,
			left,
			width,
			top:
				AI_EDIT_ITEM_VERTICAL_GAP_PX +
				(index % AI_EDIT_VISUAL_LANES) *
					(AI_EDIT_ITEM_HEIGHT_PX + AI_EDIT_ITEM_VERTICAL_GAP_PX),
			index,
		};
	});
}

export const AiEditTrack = memo(function AiEditTrack({
	items,
	zoomLevel,
	dynamicTimelineWidth,
	scrollLeft,
	viewportWidth,
	interactionDisabled,
	onSeek,
	onMouseDown,
	onMouseUp,
}: {
	items: readonly AiEditTimelineItem[];
	zoomLevel: number;
	dynamicTimelineWidth: number;
	scrollLeft: number;
	viewportWidth: number;
	interactionDisabled: boolean;
	onSeek: (time: MediaTime) => void;
	onMouseDown: (event: React.MouseEvent) => void;
	onMouseUp: (event: React.MouseEvent) => void;
}) {
	const visibleLayouts = useMemo(() => {
		const viewportStart = Math.max(
			0,
			scrollLeft - AI_EDIT_HORIZONTAL_OVERSCAN_PX,
		);
		const viewportEnd =
			scrollLeft + viewportWidth + AI_EDIT_HORIZONTAL_OVERSCAN_PX;
		return buildLayouts({ items, zoomLevel }).filter(
			(layout) =>
				layout.left + layout.width >= viewportStart &&
				layout.left <= viewportEnd,
		);
	}, [items, scrollLeft, viewportWidth, zoomLevel]);

	return (
		// eslint-disable-next-line jsx-a11y/no-static-element-interactions -- virtual timeline lane is a spatial gesture surface; individual provenance layers are native buttons.
		<div
			className="relative overflow-hidden border-b border-violet-400/20 bg-violet-950/10"
			style={{
				width: `${dynamicTimelineWidth}px`,
				height: `${AI_EDIT_TRACK_HEIGHT_PX}px`,
			}}
			onMouseDown={onMouseDown}
			onMouseUp={onMouseUp}
			aria-label="AI edit activity track"
		>
			<div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex items-center px-1.5 text-[9px] font-semibold uppercase tracking-wide text-violet-200/50">
				AI
			</div>
			{visibleLayouts.map(({ item, left, width, top, index }) => {
				const isMarker = item.anchor.kind !== "range";
				return (
					<button
						key={item.key}
						type="button"
						className={cn(
							"absolute z-20 overflow-hidden border text-left text-[9px] leading-none shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-200",
							item.anchor.kind === "project"
								? "rounded-full border-fuchsia-300/60 bg-fuchsia-500/45 text-fuchsia-50"
								: "rounded-sm border-violet-300/45 bg-violet-500/25 text-violet-50 hover:bg-violet-500/40",
							item.tombstone &&
								"border-dashed border-amber-300/70 bg-amber-500/20 text-amber-50",
							interactionDisabled && "cursor-crosshair",
						)}
						style={{
							left,
							width,
							top,
							height: AI_EDIT_ITEM_HEIGHT_PX,
							zIndex: 20 + (index % 10),
						}}
						title={getItemTitle(item)}
						aria-label={`Seek to AI edit: ${item.label}`}
						data-ai-edit-kind={item.anchor.kind}
						data-ai-edit-layer-id={item.layerId}
						onMouseDown={(event) => {
							if (!interactionDisabled) event.stopPropagation();
						}}
						onMouseUp={(event) => {
							if (!interactionDisabled) event.stopPropagation();
						}}
						onClick={(event) => {
							if (interactionDisabled) return;
							event.stopPropagation();
							onSeek(item.seekTime);
						}}
					>
						{!isMarker && (
							<span className="block truncate px-1">{item.label}</span>
						)}
					</button>
				);
			})}
		</div>
	);
});
