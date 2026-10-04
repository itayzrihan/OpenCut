"use client";

import { useEffect, useRef, useState } from "react";
import { FolderOpen, Layers2, MoreHorizontal, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { cn } from "@/utils/ui";
import type { HyperframesLibraryItem } from "./types";

const EMPTY_ITEMS: HyperframesLibraryItem[] = [];

/** The registry owns library identity and usage; this is a disposable view projection. */
export function useHyperframesLibrary() {
	const editor = useEditor();
	const project = useEditorProject((e) => e.project.getActiveOrNull());
	const scenes = useEditorTimelineScenes((e) => e.scenes.getScenes());
	const projectId = project?.metadata.id;
	const compositions = project?.hyperframesCompositions;
	const [result, setResult] = useState<{
		projectId: string;
		items: HyperframesLibraryItem[];
		error?: string;
	} | null>(null);
	useEffect(() => {
		let active = true;
		if (!projectId || !compositions || !Object.keys(compositions).length)
			return;
		void editor.command.readHyperframesLibrary({ projectId }).then(
			({ items }) => {
				if (active) setResult({ projectId, items });
			},
			(error: unknown) => {
				if (active)
					setResult({
						projectId,
						items: EMPTY_ITEMS,
						error:
							error instanceof Error
								? error.message
								: "Could not load compositions",
					});
			},
		);
		return () => {
			active = false;
		};
	}, [editor, projectId, compositions, scenes]);
	if (
		!result ||
		!compositions ||
		!Object.keys(compositions).length ||
		result?.projectId !== projectId
	)
		return { items: EMPTY_ITEMS, error: undefined };
	return result;
}

export function HyperframesLibraryCard({
	item,
	variant,
	onShowFiles,
}: {
	item: HyperframesLibraryItem;
	variant: "grid" | "compact";
	onShowFiles: (assetId: string) => void;
}) {
	const editor = useEditor();
	const busy = useRef(false);
	const [adding, setAdding] = useState(false);
	const isGrid = variant === "grid";
	const add = async () => {
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
		if (!projectId || !sceneId || busy.current) return;
		busy.current = true;
		setAdding(true);
		try {
			await editor.command.insertHyperframes({
				projectId,
				sceneId,
				assetId: item.assetId,
				name: item.name,
				startSeconds: editor.playback.getCurrentTime() / TICKS_PER_SECOND,
			});
		} catch (error) {
			toast.error("Could not add composition", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			busy.current = false;
			setAdding(false);
		}
	};
	const showInTimeline = async () => {
		const currentSceneId = editor.scenes.getActiveSceneOrNull()?.id;
		const occurrence =
			item.occurrences.find((entry) => entry.sceneId === currentSceneId) ??
			item.occurrences[0];
		if (!occurrence) return;
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		try {
			if (currentSceneId !== occurrence.sceneId)
				await editor.scenes.switchToScene({ sceneId: occurrence.sceneId });
			if (editor.project.getActiveOrNull()?.metadata.id !== projectId) return;
			editor.selection.setSelectedElements({
				elements: [
					{ trackId: occurrence.trackId, elementId: occurrence.elementId },
				],
			});
			editor.playback.seek({
				time: mediaTimeFromSeconds({
					seconds: occurrence.startTime / TICKS_PER_SECOND,
				}),
			});
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not show composition",
			);
		}
	};
	return (
		<div
			className={cn(
				"group min-w-0",
				isGrid ? "w-28" : "flex h-9 w-full items-center gap-2",
			)}
			data-hyperframes-library-item={item.assetId}
		>
			<button
				type="button"
				aria-label={`Show files for ${item.name}`}
				title={`${item.name} · ${item.width} × ${item.height} · ${item.durationSeconds}s`}
				className={cn(
					"flex items-center justify-center rounded-sm border border-violet-400/20 bg-violet-400/10 text-violet-300 hover:bg-violet-400/20 focus-visible:outline focus-visible:outline-2",
					isGrid ? "relative h-16 w-full" : "size-7 shrink-0",
				)}
				draggable
				onDragStart={(event) =>
					editor.timeline.dragSource.begin({
						dataTransfer: event.dataTransfer,
						dragData: {
							id: item.assetId,
							type: "graphic",
							definitionId: "hyperframes",
							name: item.name,
							duration: mediaTimeFromSeconds({ seconds: item.durationSeconds }),
							params: {
								hyperframesAssetId: item.assetId,
								sourceWidth: item.width,
								sourceHeight: item.height,
							},
						},
					})
				}
				onDragEnd={() => editor.timeline.dragSource.end()}
				onClick={() => onShowFiles(item.assetId)}
			>
				<Layers2 className={isGrid ? "size-6" : "size-4"} />
				{isGrid && (
					<span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 text-[10px] text-foreground">
						{Math.floor(item.durationSeconds / 60)}:
						{Math.floor(item.durationSeconds % 60)
							.toString()
							.padStart(2, "0")}
					</span>
				)}
			</button>
			<div className={cn("min-w-0", isGrid ? "pt-1" : "flex-1")}>
				<div className="truncate text-xs" title={item.name}>
					{item.name}
				</div>
				<div className="text-[10px] text-muted-foreground">
					HyperFrames{!isGrid && ` · ${item.resourceAssetIds.length} files`}
				</div>
			</div>
			<div className={cn("flex items-center", isGrid && "justify-between")}>
				{isGrid && (
					<button
						type="button"
						className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
						onClick={() => onShowFiles(item.assetId)}
					>
						<FolderOpen className="size-3" />
						{item.resourceAssetIds.length} files
					</button>
				)}
				<div className="flex">
					<Button
						size="icon"
						variant="ghost"
						className="size-6"
						aria-label={`Add ${item.name} at playhead`}
						title="Add at playhead"
						disabled={adding}
						onClick={() => void add()}
					>
						<Plus />
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								className="size-6"
								aria-label={`Options for ${item.name}`}
							>
								<MoreHorizontal />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem disabled={adding} onSelect={() => void add()}>
								Add at playhead
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => onShowFiles(item.assetId)}>
								Show files
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!item.occurrences.length}
								onSelect={() => void showInTimeline()}
							>
								Show in timeline
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
		</div>
	);
}
