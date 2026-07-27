"use client";

import { useMemo, useRef } from "react";
import { UI_ELEMENT_GRAPHIC_ID } from "@/graphics/definitions/ui-element";
import type { ParamValues } from "@/params";
import type { GraphicElement } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";

const MARKER_SIZE_PX = 22;
const MIN_MARKER_ELEMENT_WIDTH_PX = 96;
const LIST_TEMPLATES = new Set(["bullet-list", "checkbox-list", "leaderboard"]);

type UiMarker =
	| {
			id: string;
			type: "global";
			paramKey: "animationInEnd" | "eventAt" | "animationOutStart";
			label: string;
			title: string;
			percent: number;
			tone: "in" | "event" | "out";
	  }
	| {
			id: string;
			type: "item";
			edge: "start" | "end";
			index: number;
			label: string;
			title: string;
			percent: number;
			tone: "item-start" | "item-end";
	  };

export function UiElementTimelineMarkers({
	element,
	trackId,
	elementWidth,
	baseTrackHeight,
	isSelected,
}: {
	element: GraphicElement;
	trackId: string;
	elementWidth: number;
	baseTrackHeight: number;
	isSelected: boolean;
}) {
	const editor = useEditor();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{
		marker: UiMarker;
		baseParams: ParamValues;
		itemStarts: number[];
		itemEnds: number[];
		itemCount: number;
	} | null>(null);

	const markers = useMemo(() => {
		if (
			element.definitionId !== UI_ELEMENT_GRAPHIC_ID ||
			elementWidth < MIN_MARKER_ELEMENT_WIDTH_PX
		) {
			return [];
		}
		return buildUiMarkers({ params: element.params });
	}, [element.definitionId, element.params, elementWidth]);

	if (markers.length === 0) {
		return null;
	}

	const previewMarker = ({
		marker,
		clientX,
	}: {
		marker: UiMarker;
		clientX: number;
	}) => {
		const root = rootRef.current;
		const drag = dragRef.current;
		if (!root || !drag) return;
		const rect = root.getBoundingClientRect();
		const nextPercent = clampPercent(
			((clientX - rect.left) / rect.width) * 100,
		);
		const params = buildParamsForMarkerDrag({
			marker,
			percent: nextPercent,
			baseParams: drag.baseParams,
			itemStarts: drag.itemStarts,
			itemEnds: drag.itemEnds,
			itemCount: drag.itemCount,
		});
		editor.timeline.previewElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					updates: { params },
				},
			],
		});
	};

	const handleMarkerMouseDown = ({
		event,
		marker,
	}: {
		event: React.MouseEvent;
		marker: UiMarker;
	}) => {
		event.preventDefault();
		event.stopPropagation();

		const itemCount = getUiItemCount({ params: element.params });
		const timing = getItemTiming({
			params: element.params,
			itemCount,
		});
		dragRef.current = {
			marker,
			baseParams: element.params,
			itemStarts: timing.starts,
			itemEnds: timing.ends,
			itemCount,
		};

		const handleMouseMove = (moveEvent: MouseEvent) => {
			moveEvent.preventDefault();
			previewMarker({ marker, clientX: moveEvent.clientX });
		};
		const handleMouseUp = (upEvent: MouseEvent) => {
			upEvent.preventDefault();
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			dragRef.current = null;
			editor.timeline.commitPreview();
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
	};

	return (
		<div
			ref={rootRef}
			className={cn(
				"pointer-events-none absolute inset-0 z-20",
				!isSelected && "opacity-70",
			)}
			style={{ height: `${baseTrackHeight}px` }}
		>
			{markers.map((marker) => (
				<button
					key={marker.id}
					type="button"
					className={cn(
						"pointer-events-auto absolute -translate-x-1/2 rounded-full border text-[0.65rem] font-bold leading-none shadow-sm",
						"flex items-center justify-center cursor-grab active:cursor-grabbing",
						getMarkerClassName({ marker }),
					)}
					style={{
						left: `${marker.percent}%`,
						top: getMarkerTop({ marker }),
						width: MARKER_SIZE_PX,
						height: MARKER_SIZE_PX,
					}}
					title={marker.title}
					aria-label={marker.title}
					onMouseDown={(event) => handleMarkerMouseDown({ event, marker })}
					onClick={(event) => event.stopPropagation()}
				>
					{marker.label}
				</button>
			))}
		</div>
	);
}

function buildUiMarkers({ params }: { params: ParamValues }): UiMarker[] {
	const animationInEnd = getNumberParam({
		params,
		key: "animationInEnd",
		fallback: 18,
	});
	const eventAt = getNumberParam({ params, key: "eventAt", fallback: 55 });
	const animationOutStart = getNumberParam({
		params,
		key: "animationOutStart",
		fallback: 82,
	});
	const markers: UiMarker[] = [
		{
			id: "ui-animation-in-end",
			type: "global",
			paramKey: "animationInEnd",
			label: "1",
			title: "Animation in endpoint",
			percent: animationInEnd,
			tone: "in",
		},
		{
			id: "ui-animation-event",
			type: "global",
			paramKey: "eventAt",
			label: "2",
			title: "Selected event moment",
			percent: eventAt,
			tone: "event",
		},
		{
			id: "ui-animation-out-start",
			type: "global",
			paramKey: "animationOutStart",
			label: "3",
			title: "Animation out start point",
			percent: animationOutStart,
			tone: "out",
		},
	];

	const template = String(params.template ?? "");
	if (!LIST_TEMPLATES.has(template)) {
		return markers;
	}

	const itemCount = getUiItemCount({ params });
	const itemTiming = getItemTiming({ params, itemCount });
	for (let index = 0; index < itemCount; index++) {
		const label = String(index + 1);
		markers.push(
			{
				id: `ui-item-${index}-start`,
				type: "item",
				edge: "start",
				index,
				label,
				title: `Item ${label} start point`,
				percent: itemTiming.starts[index],
				tone: "item-start",
			},
			{
				id: `ui-item-${index}-end`,
				type: "item",
				edge: "end",
				index,
				label,
				title: `Item ${label} end point`,
				percent: itemTiming.ends[index],
				tone: "item-end",
			},
		);
	}

	return markers;
}

function buildParamsForMarkerDrag({
	marker,
	percent,
	baseParams,
	itemStarts,
	itemEnds,
	itemCount,
}: {
	marker: UiMarker;
	percent: number;
	baseParams: ParamValues;
	itemStarts: number[];
	itemEnds: number[];
	itemCount: number;
}): ParamValues {
	if (marker.type === "global") {
		const animationInEnd = getNumberParam({
			params: baseParams,
			key: "animationInEnd",
			fallback: 18,
		});
		const animationOutStart = getNumberParam({
			params: baseParams,
			key: "animationOutStart",
			fallback: 82,
		});
		const value =
			marker.paramKey === "animationInEnd"
				? clampValue({ value: percent, min: 1, max: animationOutStart - 1 })
				: marker.paramKey === "animationOutStart"
					? clampValue({ value: percent, min: animationInEnd + 1, max: 99 })
					: percent;
		return {
			...baseParams,
			[marker.paramKey]: roundPercent(value),
		};
	}

	const starts = itemStarts.slice(0, itemCount);
	const ends = itemEnds.slice(0, itemCount);
	if (marker.edge === "start") {
		starts[marker.index] = roundPercent(
			clampValue({
				value: percent,
				min: 0,
				max: (ends[marker.index] ?? 100) - 1,
			}),
		);
	} else {
		ends[marker.index] = roundPercent(
			clampValue({
				value: percent,
				min: (starts[marker.index] ?? 0) + 1,
				max: 100,
			}),
		);
	}

	return {
		...baseParams,
		itemStartPoints: formatPercentList({ values: starts }),
		itemEndPoints: formatPercentList({ values: ends }),
	};
}

function getItemTiming({
	params,
	itemCount,
}: {
	params: ParamValues;
	itemCount: number;
}) {
	const animationInEnd = getNumberParam({
		params,
		key: "animationInEnd",
		fallback: 18,
	});
	const animationOutStart = getNumberParam({
		params,
		key: "animationOutStart",
		fallback: 82,
	});
	return {
		starts: parsePercentList({
			value: String(params.itemStartPoints ?? ""),
			count: itemCount,
			fallback: (index) =>
				itemCount <= 1
					? 0
					: (animationInEnd / Math.max(1, itemCount - 1)) * index,
		}),
		ends: parsePercentList({
			value: String(params.itemEndPoints ?? ""),
			count: itemCount,
			fallback: () => animationOutStart,
		}),
	};
}

function getUiItemCount({ params }: { params: ParamValues }): number {
	const explicitCount = Number(params.itemCount ?? 0);
	if (Number.isFinite(explicitCount) && explicitCount > 0) {
		return Math.round(clampValue({ value: explicitCount, min: 1, max: 8 }));
	}
	return String(params.items ?? "")
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean)
		.slice(0, 6).length;
}

function getMarkerTop({ marker }: { marker: UiMarker }) {
	if (marker.type === "global") {
		return "50%";
	}
	return marker.edge === "start"
		? "6px"
		: `calc(100% - ${MARKER_SIZE_PX + 6}px)`;
}

function getMarkerClassName({ marker }: { marker: UiMarker }) {
	switch (marker.tone) {
		case "in":
			return "bg-cyan-300 text-slate-950 border-cyan-50";
		case "event":
			return "bg-fuchsia-300 text-slate-950 border-fuchsia-50";
		case "out":
			return "bg-amber-300 text-slate-950 border-amber-50";
		case "item-start":
			return "bg-emerald-300 text-slate-950 border-emerald-50";
		case "item-end":
			return "bg-rose-300 text-slate-950 border-rose-50";
	}
}

function parsePercentList({
	value,
	count,
	fallback,
}: {
	value: string;
	count: number;
	fallback: (index: number) => number;
}): number[] {
	const parsed = value
		.split(",")
		.map((entry) => Number(entry.trim()))
		.filter((entry) => Number.isFinite(entry));
	return Array.from({ length: count }, (_, index) =>
		roundPercent(
			clampValue({
				value: parsed[index] ?? fallback(index),
				min: 0,
				max: 100,
			}),
		),
	);
}

function formatPercentList({ values }: { values: number[] }) {
	return values.map((value) => String(roundPercent(value))).join(",");
}

function getNumberParam({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = Number(params[key] ?? fallback);
	return Number.isFinite(value) ? clampPercent(value) : fallback;
}

function clampPercent(value: number) {
	return clampValue({ value, min: 0, max: 100 });
}

function clampValue({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	return Math.max(min, Math.min(max, value));
}

function roundPercent(value: number) {
	return Math.round(value * 10) / 10;
}
