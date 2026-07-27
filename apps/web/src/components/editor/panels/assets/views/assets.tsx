"use client";

import Image from "next/image";
import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import {
	List,
	type ListImperativeAPI,
	type RowComponentProps,
} from "react-window";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import {
	useEditor,
	useEditorMedia,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";
import { invokeAction } from "@/actions";
import { processLocalDriveMedia, processMediaAssets } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import { pickLocalMedia } from "@/services/local-drive/client";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionScope,
} from "@/selection";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { PodcastSyncDialog } from "@/podcast-sync/components/podcast-sync-dialog";
import { unnestSceneTracks } from "@/podcast-sync/scene";
import { exportSceneToPremiereXml } from "@/export/premiere-xml";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import type { TScene } from "@/timeline";
import { cn } from "@/utils/ui";
import { useContainerSize } from "@/hooks/use-container-size";
import {
	MEDIA_COMPACT_ROW_HEIGHT_PX,
	MEDIA_GRID_ROW_HEIGHT_PX,
	MEDIA_LIST_FALLBACK_HEIGHT_PX,
	MEDIA_LIST_OVERSCAN_ROWS,
	getMediaGridColumnCount,
	getMediaVirtualRowCount,
	getMediaVirtualRowEntries,
} from "./assets-virtualization";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { FileOutput, Layers2, SplitSquareHorizontal } from "lucide-react";

type MediaListEntry =
	| { type: "media"; item: MediaAsset }
	| { type: "sequence"; scene: TScene };

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = useEditorMedia((e) => e.media.getAssets());
	const activeProject = useEditorProject((e) => e.project.getActive());
	const [scenes, activeScene] = useEditorTimelineScenes((e) => [
		e.scenes.getScenes(),
		e.scenes.getActiveSceneOrNull(),
	]);

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
	} = useAssetsPanelStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);
	const [podcastSyncAssets, setPodcastSyncAssets] = useState<
		MediaAsset[] | null
	>(null);
	const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
	const mediaListViewportRef = useRef<HTMLDivElement>(null);
	const { width: mediaListViewportWidth, height: mediaListViewportHeight } =
		useContainerSize({ containerRef: mediaListViewportRef });

	const processFiles = async ({ files }: { files: File[] }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error("No active project");
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: files.length,
				promise: async () => {
					const processedAssets = await processMediaAssets({
						files,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error processing files:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const importFromDrive = async () => {
		if (!activeProject || isProcessing) return;
		setIsProcessing(true);
		setProgress(0);
		try {
			const records = await pickLocalMedia({
				projectId: activeProject.metadata.id,
			});
			if (records.length === 0) return;
			await showMediaUploadToast({
				filesCount: records.length,
				promise: async () => {
					const processedAssets = await processLocalDriveMedia({
						projectId: activeProject.metadata.id,
						records,
						onProgress: ({ progress }) => setProgress(progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Drive import failed:", error);
			toast.error("Could not import from the drive", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, fileInputProps } = useFileUpload({
		accept: "image/*,video/*,audio/*",
		multiple: true,
		onFilesSelected: (files) => processFiles({ files }),
	});

	const handleRemove = useCallback(
		({ event, ids }: { event: React.MouseEvent; ids: string[] }) => {
			event.stopPropagation();
			if (!activeProject) return;

			invokeAction("remove-media-assets", {
				projectId: activeProject.metadata.id,
				assetIds: ids,
			});
		},
		[activeProject],
	);

	const handleSort = useCallback(
		({ key }: { key: MediaSortKey }) => {
			if (mediaSortBy === key) {
				setMediaSort({
					key,
					order: mediaSortOrder === "asc" ? "desc" : "asc",
				});
			} else {
				setMediaSort({ key, order: "asc" });
			}
		},
		[mediaSortBy, mediaSortOrder, setMediaSort],
	);

	const filteredMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);

		filtered.sort((a, b) => {
			let valueA: string | number;
			let valueB: string | number;

			switch (mediaSortBy) {
				case "name":
					valueA = a.name.toLowerCase();
					valueB = b.name.toLowerCase();
					break;
				case "type":
					valueA = a.type;
					valueB = b.type;
					break;
				case "duration":
					valueA = a.duration || 0;
					valueB = b.duration || 0;
					break;
				case "size":
					valueA = a.size ?? a.file?.size ?? 0;
					valueB = b.size ?? b.file?.size ?? 0;
					break;
				default:
					return 0;
			}

			if (valueA < valueB) return mediaSortOrder === "asc" ? -1 : 1;
			if (valueA > valueB) return mediaSortOrder === "asc" ? 1 : -1;
			return 0;
		});

		return filtered;
	}, [mediaFiles, mediaSortBy, mediaSortOrder]);
	const orderedMediaIds = useMemo(() => {
		return filteredMediaItems.map((item) => item.id);
	}, [filteredMediaItems]);
	const sequenceScenes = useMemo(
		() => scenes.filter((scene) => !scene.isMain),
		[scenes],
	);

	const handleCreatePodcastSync = useCallback(
		({ ids }: { ids: string[] }) => {
			if (ids.length === 0) {
				setPodcastSyncAssets(mediaFiles.filter((asset) => !asset.ephemeral));
				return;
			}
			const selectedIdSet = new Set(ids);
			setPodcastSyncAssets(
				mediaFiles.filter(
					(asset) => !asset.ephemeral && selectedIdSet.has(asset.id),
				),
			);
		},
		[mediaFiles],
	);

	const handleOpenSequence = useCallback(
		async ({ sceneId }: { sceneId: string }) => {
			try {
				await editor.scenes.switchToScene({ sceneId });
			} catch (error) {
				console.error("Failed to open sequence:", error);
				toast.error("Failed to open sequence");
			}
		},
		[editor],
	);

	const handleUnnestSequence = useCallback(
		({ scene }: { scene: TScene }) => {
			if (!activeScene) return;
			if (activeScene.id === scene.id) {
				toast.error("Open another scene before unnesting this sequence");
				return;
			}
			const tracks = unnestSceneTracks({
				targetTracks: activeScene.tracks,
				sourceScene: scene,
				startTime: editor.playback.getCurrentTime(),
			});
			editor.timeline.updateTracks(tracks);
			toast.success("Sequence unnested into timeline");
		},
		[activeScene, editor],
	);
	const handlePremiereExport = useCallback(
		({ scene }: { scene: TScene }) => {
			if (!activeProject) {
				toast.error("Project is not available");
				return;
			}
			try {
				exportSceneToPremiereXml({
					scene,
					mediaAssets: mediaFiles,
					fps: activeProject.settings.fps,
					canvasSize: activeProject.settings.canvasSize,
				});
				toast.success(`Exported “${scene.name}” for Premiere Pro`);
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Premiere XML export failed",
				);
			}
		},
		[activeProject, mediaFiles],
	);
	const handleSelectionChange = useCallback(
		(selection: { selectedIds: string[] }) => {
			setSelectedMediaIds(selection.selectedIds);
		},
		[],
	);
	const handlePodcastSyncSelected = useCallback(() => {
		handleCreatePodcastSync({ ids: selectedMediaIds });
	}, [handleCreatePodcastSync, selectedMediaIds]);

	return (
		<>
			<input {...fileInputProps} />
			<PodcastSyncDialog
				key={podcastSyncAssets?.map((asset) => asset.id).join(":") ?? "closed"}
				open={podcastSyncAssets !== null}
				onOpenChange={(open) => {
					if (!open) setPodcastSyncAssets(null);
				}}
				assets={podcastSyncAssets ?? []}
			/>

			<PanelView
				title="Assets"
				actions={
					<MediaActions
						mediaViewMode={mediaViewMode}
						setMediaViewMode={setMediaViewMode}
						isProcessing={isProcessing}
						sortBy={mediaSortBy}
						sortOrder={mediaSortOrder}
						onSort={handleSort}
						onImport={() => void importFromDrive()}
						selectedCount={selectedMediaIds.length}
						onPodcastSync={handlePodcastSyncSelected}
					/>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="h-full min-h-0"
				scrollClassName="overflow-hidden"
				scrollRef={mediaListViewportRef}
				{...dragProps}
			>
				{isDragOver ||
				(filteredMediaItems.length === 0 && sequenceScenes.length === 0) ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={() => void importFromDrive()}
					/>
				) : (
					<SelectableSurface
						ariaLabel="Assets"
						orderedIds={orderedMediaIds}
						revealId={highlightMediaId}
						onRevealComplete={clearHighlight}
						onSelectionChange={handleSelectionChange}
					>
						<MediaScopeRegistrar />
						<MediaItemList
							items={filteredMediaItems}
							sequences={sequenceScenes}
							mode={mediaViewMode}
							viewportWidth={mediaListViewportWidth}
							viewportHeight={mediaListViewportHeight}
							revealId={highlightMediaId}
							onRemove={handleRemove}
							onCreatePodcastSync={handleCreatePodcastSync}
							onOpenSequence={handleOpenSequence}
							onUnnestSequence={handleUnnestSequence}
							onPremiereExport={handlePremiereExport}
						/>
					</SelectableSurface>
				)}
			</PanelView>
		</>
	);
}

function MediaScopeRegistrar() {
	useSelectionScope();
	return null;
}

function MediaAssetDraggable({
	item,
	preview,
	variant,
	isRounded,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	variant: "card" | "compact";
	isRounded?: boolean;
}) {
	const editor = useEditor();

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: MediaTime;
	}) => {
		const duration =
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={item.name}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			isRounded={isRounded}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
	onCreatePodcastSync,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	onCreatePodcastSync: ({ ids }: { ids: string[] }) => void;
}) {
	const { isSelected, selectedIds } = useSelection();
	const idsToDelete = isSelected(item.id) ? selectedIds : [item.id];
	const deleteLabel =
		idsToDelete.length > 1 ? `Delete ${idsToDelete.length} items` : "Delete";

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>Export clips</ContextMenuItem>
				<ContextMenuItem
					onClick={() => onCreatePodcastSync({ ids: idsToDelete })}
				>
					Create podcast sync sequence
				</ContextMenuItem>
				<ContextMenuItem
					variant="destructive"
					onClick={(event: React.MouseEvent<HTMLDivElement>) =>
						onRemove({ event, ids: idsToDelete })
					}
				>
					{deleteLabel}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaItemList({
	items,
	sequences,
	mode,
	viewportWidth,
	viewportHeight,
	revealId,
	onRemove,
	onCreatePodcastSync,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: {
	items: MediaAsset[];
	sequences: TScene[];
	mode: MediaViewMode;
	viewportWidth: number;
	viewportHeight: number;
	revealId: string | null;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	onCreatePodcastSync: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
}) {
	const isGrid = mode === "grid";
	const listRef = useRef<ListImperativeAPI | null>(null);
	const listWidth = Math.max(1, viewportWidth - 16);
	const listHeight = Math.max(
		1,
		(viewportHeight || MEDIA_LIST_FALLBACK_HEIGHT_PX) - 8,
	);
	const columnCount = isGrid
		? getMediaGridColumnCount({ width: listWidth })
		: 1;
	const rowHeight = isGrid
		? MEDIA_GRID_ROW_HEIGHT_PX
		: MEDIA_COMPACT_ROW_HEIGHT_PX;
	const entries = useMemo<MediaListEntry[]>(
		() => [
			...items.map((item) => ({ type: "media" as const, item })),
			...sequences.map((scene) => ({ type: "sequence" as const, scene })),
		],
		[items, sequences],
	);
	const rowCount = getMediaVirtualRowCount({
		entryCount: entries.length,
		mode,
		columnCount,
	});
	const mediaEntryIndexById = useMemo(() => {
		const indexById = new Map<string, number>();
		entries.forEach((entry, index) => {
			if (entry.type === "media") {
				indexById.set(entry.item.id, index);
			}
		});
		return indexById;
	}, [entries]);

	useEffect(() => {
		if (!revealId) {
			return;
		}

		const entryIndex = mediaEntryIndexById.get(revealId);
		if (entryIndex === undefined) {
			return;
		}

		listRef.current?.scrollToRow({
			align: "center",
			behavior: "auto",
			index: isGrid ? Math.floor(entryIndex / columnCount) : entryIndex,
		});
	}, [columnCount, isGrid, listRef, mediaEntryIndexById, revealId]);

	if (entries.length === 0) {
		return null;
	}

	return (
		<List
			className="scrollbar-hidden"
			listRef={listRef}
			rowCount={rowCount}
			rowHeight={rowHeight}
			overscanCount={MEDIA_LIST_OVERSCAN_ROWS}
			rowComponent={MediaListRow}
			rowProps={{
				columnCount,
				entries,
				mode,
				onCreatePodcastSync,
				onOpenSequence,
				onRemove,
				onUnnestSequence,
				onPremiereExport,
			}}
			style={{ height: listHeight, width: "100%" }}
		/>
	);
}

type MediaListRowProps = {
	columnCount: number;
	entries: MediaListEntry[];
	mode: MediaViewMode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	onCreatePodcastSync: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
};

function MediaListRow({
	index,
	style,
	columnCount,
	entries,
	mode,
	onRemove,
	onCreatePodcastSync,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: RowComponentProps<MediaListRowProps>) {
	const isGrid = mode === "grid";
	const rowEntries = getMediaVirtualRowEntries({
		entries,
		mode,
		columnCount,
		rowIndex: index,
	});

	return (
		<div
			className={cn(isGrid ? "flex gap-4" : "w-full")}
			style={style as CSSProperties}
		>
			{rowEntries.map((entry) => (
				<MediaListEntryItem
					key={entry.type === "media" ? entry.item.id : entry.scene.id}
					entry={entry}
					variant={isGrid ? "grid" : "compact"}
					onRemove={onRemove}
					onCreatePodcastSync={onCreatePodcastSync}
					onOpenSequence={onOpenSequence}
					onUnnestSequence={onUnnestSequence}
					onPremiereExport={onPremiereExport}
				/>
			))}
		</div>
	);
}

const MediaListEntryItem = memo(function MediaListEntryItem({
	entry,
	variant,
	onRemove,
	onCreatePodcastSync,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: {
	entry: MediaListEntry;
	variant: "grid" | "compact";
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	onCreatePodcastSync: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
}) {
	const isGrid = variant === "grid";

	if (entry.type === "sequence") {
		return (
			<SequenceItem
				scene={entry.scene}
				variant={variant}
				onOpenSequence={onOpenSequence}
				onUnnestSequence={onUnnestSequence}
				onPremiereExport={onPremiereExport}
			/>
		);
	}

	return (
		<MediaItemWithContextMenu
			item={entry.item}
			onRemove={onRemove}
			onCreatePodcastSync={onCreatePodcastSync}
		>
			<SelectableItem className={cn(!isGrid && "w-full")} id={entry.item.id}>
				<MediaAssetDraggable
					item={entry.item}
					preview={
						<MediaPreview
							item={entry.item}
							variant={isGrid ? "grid" : "compact"}
						/>
					}
					variant={isGrid ? "card" : "compact"}
					isRounded={isGrid ? false : undefined}
				/>
			</SelectableItem>
		</MediaItemWithContextMenu>
	);
});
MediaListEntryItem.displayName = "MediaListEntryItem";

function SequenceItem({
	scene,
	variant,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: {
	scene: TScene;
	variant: "grid" | "compact";
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
}) {
	const isGrid = variant === "grid";
	const content = (
		<button
			type="button"
			className={cn(
				"group flex min-w-0 items-center overflow-hidden rounded border bg-background text-left hover:bg-accent/40",
				isGrid ? "h-28 w-28 flex-col" : "h-12 w-full gap-2 px-2",
			)}
			onClick={() => onOpenSequence({ sceneId: scene.id })}
		>
			<div
				className={cn(
					"flex shrink-0 items-center justify-center bg-muted text-muted-foreground",
					isGrid ? "h-20 w-full" : "size-8 rounded",
				)}
			>
				<Layers2 className="size-5" />
			</div>
			<div className={cn("min-w-0", isGrid ? "w-full px-1.5 py-1" : "flex-1")}>
				<div className="truncate text-xs font-medium">{scene.name}</div>
				<div className="truncate text-[11px] text-muted-foreground">
					Sequence
				</div>
			</div>
		</button>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => onOpenSequence({ sceneId: scene.id })}>
					Open sequence
				</ContextMenuItem>
				<ContextMenuItem onClick={() => onUnnestSequence({ scene })}>
					<SplitSquareHorizontal className="size-4" />
					Unnest into timeline
				</ContextMenuItem>
				<ContextMenuItem onClick={() => onPremiereExport({ scene })}>
					<FileOutput className="size-4" />
					Export Premiere Pro XML
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");

	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const shouldShowDurationBadge = variant === "grid";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center bg-muted">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}

		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label="Video"
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio") {
		return (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label="Audio"
				duration={item.duration}
				variant="bordered"
			/>
		);
	}

	return (
		<MediaTypePlaceholder icon={Image02Icon} label="Unknown" variant="muted" />
	);
}

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSort,
	onImport,
	selectedCount,
	onPodcastSync,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
	selectedCount: number;
	onPodcastSync: () => void;
}) {
	return (
		<div className="flex gap-1.5">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? "Switch to list view"
								: "Switch to grid view"}
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={isProcessing}
									className="items-center justify-center"
								>
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							<SortMenuItem
								label="Name"
								sortKey="name"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Type"
								sortKey="type"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="Duration"
								sortKey="duration"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label="File size"
								sortKey="size"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>
						<p>
							Sort by {sortBy} (
							{sortOrder === "asc" ? "ascending" : "descending"})
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Button
				variant="outline"
				onClick={onPodcastSync}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5"
				title={
					selectedCount > 0
						? `Build podcast multicam from ${selectedCount} selected files`
						: "Build a podcast multicam sequence"
				}
			>
				<SplitSquareHorizontal className="size-4" />
				Podcast multicam
			</Button>
			<Button
				variant="outline"
				onClick={onImport}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
				Import
			</Button>
		</div>
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: MediaSortKey;
	currentSortBy: MediaSortKey;
	currentSortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";

	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}
