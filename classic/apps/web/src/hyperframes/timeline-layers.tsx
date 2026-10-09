"use client";

import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { getDisplayTracks, type TimelineTrack } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { useTimelineStore } from "@/timeline/timeline-store";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import type { HyperframesTimelineClip } from "./types";

export const HYPERFRAMES_LAYER_ROW_HEIGHT = 28;
type LayerEntry = {
	clip: HyperframesTimelineClip;
	row: HyperframesTimelineClip["rows"][number];
};
type DisplayRow = LayerEntry | { message: string; key: string };
const EMPTY_ROWS: DisplayRow[] = [];
const LayerContext = createContext<{
	rows: ReadonlyMap<string, DisplayRow[]>;
	expanded: ReadonlySet<string>;
	toggle: (trackId: string) => void;
} | null>(null);

/** Expansion is view state. All layer identity and timing come from the registry. */
export function HyperframesTimelineProvider({
	children,
}: {
	children: ReactNode;
}) {
	const editor = useEditor();
	const project = useEditorProject((e) => e.project.getActiveOrNull());
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const projectId = project?.metadata.id;
	const compositions = project?.hyperframesCompositions;
	const tracks = scene?.tracks;
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const requests = useMemo(
		() =>
			tracks
				? getDisplayTracks({ tracks }).filter((track) => expanded.has(track.id))
				: [],
		[tracks, expanded],
	);
	const [result, setResult] = useState<{
		requests: typeof requests;
		compositions: typeof compositions;
		rows: Map<string, DisplayRow[]>;
	} | null>(null);
	useEffect(() => {
		let active = true;
		if (!projectId || !scene) return;
		const accountId = window.__opencutAccountId;
		void (async () => {
			const rows = new Map<string, DisplayRow[]>();
			for (const track of requests) {
				const entries: DisplayRow[] = [];
				for (const element of track.elements) {
					if (
						element.type !== "graphic" ||
						element.definitionId !== "hyperframes"
					)
						continue;
					try {
						const { clip } = await editor.command.readHyperframesLayerRows({
							projectId,
							sceneId: scene.id,
							elementId: element.id,
						});
						if (!active || window.__opencutAccountId !== accountId) return;
						if (clip.rows.length)
							entries.push(...clip.rows.map((row) => ({ clip, row })));
						else
							entries.push({
								key: element.id,
								message: `${element.name}: no layers in this part of the clip`,
							});
					} catch (error) {
						if (!active) return;
						entries.push({
							key: element.id,
							message:
								error instanceof Error
									? error.message
									: "Could not read composition layers",
						});
					}
				}
				if (entries.length) rows.set(track.id, entries);
			}
			if (active) setResult({ requests, compositions, rows });
		})();
		return () => {
			active = false;
		};
	}, [editor, projectId, scene, requests, compositions]);
	const rows = useMemo(() => {
		if (result?.requests === requests && result.compositions === compositions)
			return result.rows;
		return new Map(
			requests.map((track) => [
				track.id,
				[{ key: "loading", message: "Loading layers…" }],
			]),
		);
	}, [result, requests, compositions]);
	const value = useMemo(
		() => ({
			rows,
			expanded,
			toggle: (trackId: string) => {
				setExpanded((current) => {
					const next = new Set(current);
					if (next.has(trackId)) next.delete(trackId);
					else next.add(trackId);
					return next;
				});
			},
		}),
		[rows, expanded],
	);
	return (
		<LayerContext.Provider value={value}>{children}</LayerContext.Provider>
	);
}

export function useHyperframesTimelineLayers() {
	const context = useContext(LayerContext);
	if (!context)
		throw new Error("Composition layer rows require their timeline provider");
	return context;
}

export function HyperframesTrackDisclosure({
	track,
	fallback,
}: {
	track: TimelineTrack;
	fallback: ReactNode;
}) {
	const { expanded, toggle } = useHyperframesTimelineLayers();
	const compounds = track.elements.filter(
		(element) =>
			element.type === "graphic" && element.definitionId === "hyperframes",
	);
	if (!compounds.length) return fallback;
	const open = expanded.has(track.id);
	const Icon = open ? ChevronDown : ChevronRight;
	const label =
		compounds.length === 1
			? compounds[0].name
			: `${track.name} (${compounds.length} compositions)`;
	return (
		<button
			type="button"
			className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
			aria-expanded={open}
			data-native-keyboard-activation
			aria-label={`${open ? "Collapse" : "Expand"} composition layers in ${label}`}
			title={`${open ? "Collapse" : "Expand"} composition layers in ${label}`}
			onClick={() => toggle(track.id)}
		>
			<Icon className="size-4" />
		</button>
	);
}

/** Same vertical coordinates in the fixed label column and the scrolling lanes. */
export function HyperframesTimelineRows({
	trackId,
	top,
	trackTop,
	scrollTop,
	viewportHeight,
	labels = false,
	zoomLevel = 1,
	scrollLeft = 0,
	viewportWidth = 0,
}: {
	trackId: string;
	top: number;
	trackTop: number;
	scrollTop: number;
	viewportHeight: number;
	labels?: boolean;
	zoomLevel?: number;
	scrollLeft?: number;
	viewportWidth?: number;
}) {
	const editor = useEditor();
	const { rows: trackRows } = useHyperframesTimelineLayers();
	const rangeLocked = useTimelineStore(
		(state) => state.aiRangeSelection.isTimelineLocked,
	);
	const rows = trackRows.get(trackId) ?? EMPTY_ROWS;
	const first = Math.max(
		0,
		Math.floor(
			(scrollTop - trackTop - top - 100) / HYPERFRAMES_LAYER_ROW_HEIGHT,
		),
	);
	const end =
		viewportHeight > 0
			? Math.ceil(
					(scrollTop + viewportHeight - trackTop - top + 100) /
						HYPERFRAMES_LAYER_ROW_HEIGHT,
				)
			: first + 30;
	return (
		<>
			{rows.slice(first, Math.max(first, end)).map((entry, offset) => {
				const y = top + (first + offset) * HYPERFRAMES_LAYER_ROW_HEIGHT;
				if ("message" in entry)
					return (
						<div
							key={entry.key}
							className="absolute left-0 right-0 truncate border-t bg-muted/30 px-2 text-xs text-muted-foreground"
							style={{
								top: y,
								height: HYPERFRAMES_LAYER_ROW_HEIGHT,
								lineHeight: `${HYPERFRAMES_LAYER_ROW_HEIGHT}px`,
								paddingLeft: labels ? 8 : scrollLeft + 8,
							}}
							title={entry.message}
						>
							{labels ? "Layers" : entry.message}
						</div>
					);
				const { clip, row } = entry;
				const left = timelineTimeToPixels({ time: row.startTime, zoomLevel });
				const width = timelineTimeToPixels({ time: row.duration, zoomLevel });
				const text = row.label || row.kind;
				const title = `${clip.name} · ${text} · ${(row.startTime / TICKS_PER_SECOND).toFixed(3)}–${((row.startTime + row.duration) / TICKS_PER_SECOND).toFixed(3)}s`;
				const jump = (event: React.MouseEvent) => {
					event.stopPropagation();
					if (rangeLocked) return;
					editor.selection.setSelectedElements({
						elements: [{ trackId: clip.trackId, elementId: clip.elementId }],
					});
					editor.playback.seek({
						time: mediaTimeFromSeconds({
							seconds: row.startTime / TICKS_PER_SECOND,
						}),
					});
				};
				return (
					<div
						key={`${clip.elementId}:${row.key}`}
						className="absolute left-0 right-0 border-t border-border/50 bg-muted/20"
						style={{ top: y, height: HYPERFRAMES_LAYER_ROW_HEIGHT }}
					>
						{labels ? (
							<button
								type="button"
								onClick={jump}
								disabled={rangeLocked}
								data-native-keyboard-activation
								onMouseDown={(event) => event.stopPropagation()}
								title={title}
								aria-label={`Jump to ${text} in ${clip.name}`}
								className="size-full truncate pr-2 text-left text-[11px] text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
								style={{ paddingLeft: 8 + Math.min(row.depth, 5) * 10 }}
							>
								{text}
							</button>
						) : (
							(viewportWidth <= 0 ||
								(left + width >= scrollLeft - 100 &&
									left <= scrollLeft + viewportWidth + 100)) && (
								<button
									type="button"
									onClick={jump}
									disabled={rangeLocked}
									data-native-keyboard-activation
									onMouseDown={(event) => event.stopPropagation()}
									title={title}
									aria-label={`Jump to ${text} in ${clip.name}`}
									className="absolute top-1 h-5 truncate rounded border border-violet-400/40 bg-violet-400/15 px-2 text-left text-[11px] hover:bg-violet-400/30 focus-visible:ring-2 focus-visible:ring-ring"
									style={{ left, width: Math.max(2, width) }}
								>
									{text}
								</button>
							)
						)}
					</div>
				);
			})}
		</>
	);
}
