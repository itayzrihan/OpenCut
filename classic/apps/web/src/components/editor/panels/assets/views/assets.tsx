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
import {
	pickLocalMedia,
	registerLocalMediaPaths,
} from "@/services/local-drive/client";
import { detectRuntimeTarget } from "@/platform/runtime-profile";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionScope,
} from "@/selection";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { PodcastSyncDialog } from "@/podcast-sync/components/podcast-sync-dialog";
import { HyperframesImportDialog } from "@/hyperframes/import-dialog";
import {
	HyperframesLibraryCard,
	useHyperframesLibrary,
} from "@/hyperframes/library";
import type { HyperframesLibraryItem } from "@/hyperframes/types";
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
import {
	createUnifiedAnglesAsset,
	isUnifiedAnglesAsset,
} from "@/media/unified-angles";
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
import {
	ChevronDown,
	FileOutput,
	Layers2,
	SplitSquareHorizontal,
	MoreHorizontal,
	Search,
	ArrowLeft,
	X,
	File,
} from "lucide-react";

type MediaListEntry =
	| { type: "media"; item: MediaAsset }
	| { type: "hyperframes"; item: HyperframesLibraryItem }
	| { type: "sequence"; scene: TScene };

/**
 * In the Electron shell, picks files via the native dialog in the main process (properly
 * parented to the app window) instead of asking the Next.js server to shell out to a system
 * dialog — that dialog has no owner window in Electron and never comes to the front. Falls back
 * to the server-side picker everywhere else (plain browser tabs, self-hosted deployments).
 */
async function pickLocalMediaRecords({ projectId }: { projectId: string }) {
	if (detectRuntimeTarget() === "electron" && window.opencutElectron) {
		const paths = await window.opencutElectron.pickMediaFiles();
		if (paths.length === 0) return [];
		return registerLocalMediaPaths({ projectId, paths });
	}
	return pickLocalMedia({ projectId });
}

export function MediaView() {
	const projectId = useEditorProject((e) => e.project.getActive().metadata.id);
	return <MediaViewContent key={projectId} />;
}

function MediaViewContent() {
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
	const library = useHyperframesLibrary();
	const [search, setSearch] = useState("");
	const [folderId, setFolderId] = useState<string | null>(null);
	const [showAllFiles, setShowAllFiles] = useState(!!highlightMediaId);
	const folder = library.items.find((item) => item.assetId === folderId);
	const resourceIds = useMemo(
		() => new Set(library.items.flatMap((item) => item.resourceAssetIds)),
		[library.items],
	);
	const folderResourceIds = useMemo(
		() => new Set(folder?.resourceAssetIds),
		[folder],
	);
	const query = search.trim().toLocaleLowerCase();
	const visibleCompositions = useMemo(
		() =>
			folder || showAllFiles
				? []
				: library.items
						.filter((item) => item.name.toLocaleLowerCase().includes(query))
						.sort((a, b) => {
							const order = mediaSortOrder === "asc" ? 1 : -1;
							return (
								order *
								(mediaSortBy === "duration"
									? a.durationSeconds - b.durationSeconds
									: a.name.localeCompare(b.name))
							);
						}),
		[folder, showAllFiles, library.items, query, mediaSortBy, mediaSortOrder],
	);
	const showCompositionFiles = useCallback((assetId: string) => {
		setFolderId(assetId);
		setSearch("");
	}, []);
	useEffect(
		() =>
			useAssetsPanelStore.subscribe((state, previous) => {
				if (
					!state.highlightMediaId ||
					state.highlightMediaId === previous.highlightMediaId
				)
					return;
				setFolderId(null);
				setSearch("");
				setShowAllFiles(true);
			}),
		[],
	);
	const [hyperframesImportOpen, setHyperframesImportOpen] = useState(false);
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
			const records = await pickLocalMediaRecords({
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
		const filtered = mediaFiles.filter(
			(item) =>
				!item.ephemeral &&
				item.name.toLocaleLowerCase().includes(query) &&
				(folder
					? folderResourceIds.has(item.id)
					: showAllFiles || !!query || !resourceIds.has(item.id)),
		);

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
	}, [
		mediaFiles,
		mediaSortBy,
		mediaSortOrder,
		query,
		folder,
		folderResourceIds,
		showAllFiles,
		resourceIds,
	]);
	const orderedMediaIds = useMemo(() => {
		return filteredMediaItems
			.filter((item) => item.type !== "file")
			.map((item) => item.id);
	}, [filteredMediaItems]);
	const sequenceScenes = useMemo(
		() =>
			folder || showAllFiles
				? []
				: scenes.filter(
						(scene) =>
							!scene.isMain &&
							!scene.parallax &&
							scene.name.toLocaleLowerCase().includes(query),
					),
		[scenes, folder, showAllFiles, query],
	);

	const handleCreatePodcastSync = useCallback(
		({ ids }: { ids: string[] }) => {
			if (ids.length === 0) {
				setPodcastSyncAssets(
					mediaFiles.filter(
						(asset) => !asset.ephemeral && asset.type !== "file",
					),
				);
				return;
			}
			const selectedIdSet = new Set(ids);
			setPodcastSyncAssets(
				mediaFiles.filter(
					(asset) =>
						!asset.ephemeral &&
						asset.type !== "file" &&
						selectedIdSet.has(asset.id),
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
					error instanceof Error ? error.message : "Premiere XML export failed",
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
	const handleUnify = useCallback(
		async ({ ids }: { ids: string[] }) => {
			if (!activeProject) return;
			const selectedIdSet = new Set(ids);
			const assets = mediaFiles.filter((asset) => selectedIdSet.has(asset.id));
			try {
				const unifiedAsset = createUnifiedAnglesAsset({ assets });
				const created = await editor.media.addMediaAsset({
					projectId: activeProject.metadata.id,
					asset: unifiedAsset,
				});
				if (!created) throw new Error("Could not save the virtual media asset");
				setSelectedMediaIds([]);
				toast.success("Unified Angles created", {
					description:
						"Drag the new virtual video to the timeline and switch angles after any cut.",
				});
			} catch (error) {
				toast.error("Could not unify these videos", {
					description: error instanceof Error ? error.message : undefined,
				});
			}
		},
		[activeProject, editor, mediaFiles],
	);
	const selectedVideosCanUnify = useMemo(() => {
		if (selectedMediaIds.length < 2) return false;
		const selected = new Set(selectedMediaIds);
		const assets = mediaFiles.filter((asset) => selected.has(asset.id));
		return (
			assets.length === selectedMediaIds.length &&
			assets.every(
				(asset) => asset.type === "video" && !isUnifiedAnglesAsset(asset),
			)
		);
	}, [mediaFiles, selectedMediaIds]);

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
			{hyperframesImportOpen && (
				<HyperframesImportDialog
					key={`${activeProject.metadata.id}:${activeScene?.id}`}
					onClose={() => setHyperframesImportOpen(false)}
				/>
			)}

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
						onImportHyperframes={() => setHyperframesImportOpen(true)}
						selectedCount={selectedMediaIds.length}
						onPodcastSync={handlePodcastSyncSelected}
						onUnify={() => void handleUnify({ ids: selectedMediaIds })}
						canUnify={selectedVideosCanUnify}
					/>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="flex h-full min-h-0 flex-col"
				scrollClassName="min-h-0 overflow-hidden"
				{...dragProps}
			>
				<div className="shrink-0 space-y-2 pb-2">
					<div className="flex h-8 items-center gap-2 rounded border px-2">
						<Search className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							aria-label="Search assets"
							placeholder={folder ? "Search these files" : "Search assets"}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							className="w-full min-w-0 bg-transparent text-xs outline-none"
						/>
						{search && (
							<button
								type="button"
								aria-label="Clear asset search"
								onClick={() => setSearch("")}
							>
								<X className="size-3.5" />
							</button>
						)}
					</div>
					{library.items.length > 0 && (
						<div className="flex h-6 items-center gap-1 text-xs">
							{folder ? (
								<>
									<Button
										variant="ghost"
										size="icon"
										className="size-6 shrink-0"
										aria-label="Back to asset library"
										onClick={() => {
											setFolderId(null);
											setSearch("");
										}}
									>
										<ArrowLeft />
									</Button>
									<span className="truncate" title={folder.name}>
										{folder.name}
									</span>
									<span className="ml-auto shrink-0 text-muted-foreground">
										{filteredMediaItems.length} files
									</span>
								</>
							) : (
								<>
									<button
										type="button"
										aria-pressed={!showAllFiles}
										className={cn(
											"rounded px-2 py-1",
											!showAllFiles
												? "bg-accent text-foreground"
												: "text-muted-foreground",
										)}
										onClick={() => setShowAllFiles(false)}
									>
										Library
									</button>
									<button
										type="button"
										aria-pressed={showAllFiles}
										className={cn(
											"rounded px-2 py-1",
											showAllFiles
												? "bg-accent text-foreground"
												: "text-muted-foreground",
										)}
										onClick={() => setShowAllFiles(true)}
									>
										All files
									</button>
								</>
							)}
						</div>
					)}
					{library.error && (
						<p role="alert" className="text-xs text-destructive">
							{library.error}
						</p>
					)}
				</div>
				<div ref={mediaListViewportRef} className="relative min-h-0 flex-1">
					{isDragOver ||
					(!query &&
						!folder &&
						filteredMediaItems.length === 0 &&
						sequenceScenes.length === 0 &&
						visibleCompositions.length === 0) ? (
						<MediaDragOverlay
							isVisible={true}
							isProcessing={isProcessing}
							progress={progress}
							onClick={() => void importFromDrive()}
						/>
					) : filteredMediaItems.length === 0 &&
					  sequenceScenes.length === 0 &&
					  visibleCompositions.length === 0 ? (
						<p className="px-2 py-8 text-center text-xs text-muted-foreground">
							{query
								? "No matching assets"
								: "No resource files in this composition"}
						</p>
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
								key={`${folder?.assetId ?? (showAllFiles ? "all" : "library")}:${query}:${mediaViewMode}`}
								items={filteredMediaItems}
								compositions={visibleCompositions}
								onShowCompositionFiles={showCompositionFiles}
								sequences={sequenceScenes}
								mode={mediaViewMode}
								viewportWidth={mediaListViewportWidth}
								viewportHeight={mediaListViewportHeight}
								revealId={highlightMediaId}
								onRemove={handleRemove}
								onCreatePodcastSync={handleCreatePodcastSync}
								onUnify={handleUnify}
								onOpenSequence={handleOpenSequence}
								onUnnestSequence={handleUnnestSequence}
								onPremiereExport={handlePremiereExport}
							/>
						</SelectableSurface>
					)}
				</div>
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
	if (item.type === "file") return null;

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
	onUnify,
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
	onUnify: ({ ids }: { ids: string[] }) => void;
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
				<ContextMenuItem onClick={() => onUnify({ ids: idsToDelete })}>
					Unify as Unified Angles
				</ContextMenuItem>
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
	compositions,
	onShowCompositionFiles,
	sequences,
	mode,
	viewportWidth,
	viewportHeight,
	revealId,
	onRemove,
	onCreatePodcastSync,
	onUnify,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: {
	items: MediaAsset[];
	compositions: HyperframesLibraryItem[];
	onShowCompositionFiles: (assetId: string) => void;
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
	onUnify: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
}) {
	const isGrid = mode === "grid";
	const listRef = useRef<ListImperativeAPI | null>(null);
	const listWidth = Math.max(1, viewportWidth);
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
			...compositions.map((item) => ({ type: "hyperframes" as const, item })),
			...items.map((item) => ({ type: "media" as const, item })),
			...sequences.map((scene) => ({ type: "sequence" as const, scene })),
		],
		[items, sequences, compositions],
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
				onShowCompositionFiles,
				mode,
				onCreatePodcastSync,
				onUnify,
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
	onShowCompositionFiles: (assetId: string) => void;
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
	onUnify: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
};

function MediaListRow({
	onShowCompositionFiles,
	index,
	style,
	columnCount,
	entries,
	mode,
	onRemove,
	onCreatePodcastSync,
	onUnify,
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
					key={
						entry.type === "sequence"
							? entry.scene.id
							: entry.type === "hyperframes"
								? entry.item.assetId
								: entry.item.id
					}
					entry={entry}
					onShowCompositionFiles={onShowCompositionFiles}
					variant={isGrid ? "grid" : "compact"}
					onRemove={onRemove}
					onCreatePodcastSync={onCreatePodcastSync}
					onUnify={onUnify}
					onOpenSequence={onOpenSequence}
					onUnnestSequence={onUnnestSequence}
					onPremiereExport={onPremiereExport}
				/>
			))}
		</div>
	);
}

const MediaListEntryItem = memo(function MediaListEntryItem({
	onShowCompositionFiles,
	entry,
	variant,
	onRemove,
	onCreatePodcastSync,
	onUnify,
	onOpenSequence,
	onUnnestSequence,
	onPremiereExport,
}: {
	entry: MediaListEntry;
	onShowCompositionFiles: (assetId: string) => void;
	variant: "grid" | "compact";
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	onCreatePodcastSync: ({ ids }: { ids: string[] }) => void;
	onUnify: ({ ids }: { ids: string[] }) => void;
	onOpenSequence: ({ sceneId }: { sceneId: string }) => void;
	onUnnestSequence: ({ scene }: { scene: TScene }) => void;
	onPremiereExport: ({ scene }: { scene: TScene }) => void;
}) {
	const isGrid = variant === "grid";
	if (entry.type === "hyperframes")
		return (
			<HyperframesLibraryCard
				item={entry.item}
				variant={variant}
				onShowFiles={onShowCompositionFiles}
			/>
		);

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

	if (entry.item.type === "file")
		return (
			<div
				className={cn(
					"text-muted-foreground",
					isGrid ? "w-28" : "flex h-8 items-center gap-3 px-1",
				)}
				title={entry.item.name}
			>
				<div
					className={cn(
						"flex items-center justify-center rounded-sm bg-muted",
						isGrid ? "h-16" : "size-6 shrink-0",
					)}
				>
					<File className="size-5" />
				</div>
				<div className="truncate text-xs">{entry.item.name}</div>
				{isGrid && <div className="text-[10px]">Resource file</div>}
			</div>
		);

	return (
		<MediaItemWithContextMenu
			item={entry.item}
			onRemove={onRemove}
			onCreatePodcastSync={onCreatePodcastSync}
			onUnify={onUnify}
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
		if (isUnifiedAnglesAsset(item)) {
			return (
				<MediaTypePlaceholder
					icon={Video01Icon}
					label="Unified Angles"
					duration={item.duration}
					variant="bordered"
				/>
			);
		}
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
	onImportHyperframes,
	selectedCount,
	onPodcastSync,
	onUnify,
	canUnify,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
	onImportHyperframes: () => void;
	selectedCount: number;
	onPodcastSync: () => void;
	onUnify: () => void;
	canUnify: boolean;
}) {
	return (
		<div className="flex gap-1">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							aria-label={
								mediaViewMode === "grid"
									? "Switch to list view"
									: "Switch to grid view"
							}
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
									aria-label="Sort assets"
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
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						aria-label="More asset actions"
						disabled={isProcessing}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={onUnify} disabled={!canUnify}>
						<Layers2 className="size-4" />
						Unify selected angles
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={onPodcastSync}>
						<SplitSquareHorizontal className="size-4" />
						Podcast multicam
						{selectedCount > 0 ? ` (${selectedCount} selected)` : ""}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<div className="flex">
				<Button
					variant="outline"
					onClick={onImport}
					disabled={isProcessing}
					size="sm"
					className="gap-1.5 rounded-r-none"
				>
					<HugeiconsIcon icon={CloudUploadIcon} />
					Import
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							disabled={isProcessing}
							className="rounded-l-none border-l-0 px-1"
							aria-label="Import options"
						>
							<ChevronDown />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={onImport}>
							Media files…
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={onImportHyperframes}>
							HyperFrames project folder…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
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
