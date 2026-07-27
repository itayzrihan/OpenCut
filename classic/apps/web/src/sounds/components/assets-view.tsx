"use client";

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
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFileUpload } from "@/media/use-file-upload";
import { useSoundSearch } from "@/sounds/use-sound-search";
import { useSoundsStore } from "@/sounds/sounds-store";
import {
	sharedLibraryService,
	useSharedLibraryStore,
	type SharedAssetCategory,
	type SharedAudioAsset,
	type SharedAudioFolder,
	type SharedCategoryScope,
} from "@/shared-library";
import type { SavedSound, SoundEffect } from "@/sounds/types";
import { cn } from "@/utils/ui";
import {
	FavouriteIcon,
	FilterMailIcon,
	Folder03Icon,
	MusicNote03Icon,
	PauseIcon,
	PlayIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const SOUND_ROW_HEIGHT_PX = 64;
const SOUND_LIST_OVERSCAN_ROWS = 8;
const SOUND_LIST_LOAD_MORE_THRESHOLD_ROWS = 8;
const SOUND_LIST_FALLBACK_HEIGHT_PX = 480;

export function SoundsView() {
	return (
		<div className="flex h-full flex-col">
			<Tabs defaultValue="sound-effects" className="flex h-full flex-col">
				<div className="px-3 pt-4 pb-0">
					<TabsList>
						<TabsTrigger value="sound-effects">Sound effects</TabsTrigger>
						<TabsTrigger value="music">Music</TabsTrigger>
						<TabsTrigger value="online">Online</TabsTrigger>
						<TabsTrigger value="saved">Saved</TabsTrigger>
					</TabsList>
				</div>
				<Separator className="my-4" />
				<TabsContent
					value="sound-effects"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SharedAudioFolderView folder="sfx" />
				</TabsContent>
				<TabsContent
					value="music"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SharedAudioFolderView folder="music" />
				</TabsContent>
				<TabsContent
					value="online"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SoundEffectsView />
				</TabsContent>
				<TabsContent
					value="saved"
					className="mt-0 flex min-h-0 flex-1 flex-col p-5 pt-0"
				>
					<SavedSoundsView />
				</TabsContent>
			</Tabs>
		</div>
	);
}

function formatAudioDuration({ seconds }: { seconds?: number }): string {
	if (!seconds || !Number.isFinite(seconds)) {
		return "--:--";
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = Math.floor(seconds % 60);
	return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatFileSize({ bytes }: { bytes: number }): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function savedSoundToSoundEffect({
	savedSound,
}: {
	savedSound: SavedSound;
}): SoundEffect {
	return {
		id: savedSound.id,
		name: savedSound.name,
		description: "",
		url: "",
		previewUrl: savedSound.previewUrl,
		downloadUrl: savedSound.downloadUrl,
		duration: savedSound.duration,
		filesize: 0,
		type: "audio",
		channels: 0,
		bitrate: 0,
		bitdepth: 0,
		samplerate: 0,
		username: savedSound.username,
		tags: savedSound.tags,
		license: savedSound.license,
		created: savedSound.savedAt,
		downloads: 0,
		rating: 0,
		ratingCount: 0,
	};
}

function getAudioScope({
	folder,
}: {
	folder: SharedAudioFolder;
}): SharedCategoryScope {
	return folder === "music" ? "audio:music" : "audio:sfx";
}

function SharedAudioFolderView({ folder }: { folder: SharedAudioFolder }) {
	const {
		audioAssets,
		categories,
		loadLibrary,
		importAudioFiles,
		createCategory,
		addAssetToCategory,
		isLoading,
	} = useSharedLibraryStore();
	const addSharedAudioToTimeline = useSoundsStore(
		(state) => state.addSharedAudioToTimeline,
	);
	const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
		null,
	);
	const [categoryName, setCategoryName] = useState("");
	const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
		null,
	);
	const scope = getAudioScope({ folder });
	const folderLabel = folder === "music" ? "Music" : "Sound effects";
	const scopedCategories = useMemo(
		() => categories.filter((category) => category.scope === scope),
		[categories, scope],
	);
	const folderAssets = useMemo(
		() => audioAssets.filter((asset) => asset.folder === folder),
		[audioAssets, folder],
	);
	const selectedCategory = selectedCategoryId
		? scopedCategories.find((category) => category.id === selectedCategoryId)
		: null;
	const displayedAssets = useMemo(() => {
		if (!selectedCategory) {
			return folderAssets;
		}
		const categoryAssetIds = new Set(selectedCategory.assetIds);
		return folderAssets.filter((asset) => categoryAssetIds.has(asset.id));
	}, [folderAssets, selectedCategory]);
	const { openFilePicker, fileInputProps } = useFileUpload({
		accept: "audio/*",
		multiple: true,
		onFilesSelected: (files) => {
			void importAudioFiles({ files, folder });
		},
	});

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	useEffect(() => {
		return () => {
			audioElement?.pause();
		};
	}, [audioElement]);

	const handleCreateCategory = async () => {
		const category = await createCategory({ scope, name: categoryName });
		if (category) {
			setSelectedCategoryId(category.id);
			setCategoryName("");
			setIsCategoryDialogOpen(false);
		}
	};

	const handleDropOnCategory = async ({
		category,
		event,
	}: {
		category: SharedAssetCategory;
		event: React.DragEvent;
	}) => {
		event.preventDefault();
		const assetId = event.dataTransfer.getData(
			"application/x-shared-audio-asset-id",
		);
		if (!assetId) return;
		await addAssetToCategory({ categoryId: category.id, assetId });
	};

	const playAsset = useCallback(
		async ({ asset }: { asset: SharedAudioAsset }) => {
			if (playingId === asset.id) {
				audioElement?.pause();
				setPlayingId(null);
				return;
			}

			audioElement?.pause();
			const audioUrl = await sharedLibraryService.getAudioAssetUrl({
				id: asset.id,
			});
			if (!audioUrl) return;

			const audio = new Audio(audioUrl);
			audio.addEventListener("ended", () => setPlayingId(null));
			audio.addEventListener("error", () => setPlayingId(null));
			audio.play().catch((error) => {
				console.error("Failed to play shared audio:", error);
				setPlayingId(null);
			});
			setAudioElement(audio);
			setPlayingId(asset.id);
		},
		[audioElement, playingId],
	);

	return (
		<div className="mt-1 flex h-full flex-col gap-4">
			<input {...fileInputProps} />
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium">{folderLabel}</p>
					<p className="text-muted-foreground text-xs">
						Copied into the repository and shared across projects
					</p>
				</div>
				<Button size="sm" onClick={openFilePicker}>
					<HugeiconsIcon icon={PlusSignIcon} />
					Add
				</Button>
			</div>

			<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden">
				<button
					type="button"
					className={cn(
						"bg-accent flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-sm border px-2 text-center",
						!selectedCategoryId && "border-primary text-primary",
					)}
					onClick={() => setSelectedCategoryId(null)}
				>
					<HugeiconsIcon
						icon={folder === "music" ? MusicNote03Icon : Folder03Icon}
						className="size-5"
					/>
					<span className="max-w-full truncate text-xs">All</span>
					<span className="text-muted-foreground text-[10px]">
						{folderAssets.length}
					</span>
				</button>
				{scopedCategories.map((category) => (
					<button
						key={category.id}
						type="button"
						className={cn(
							"bg-accent flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-sm border px-2 text-center",
							selectedCategoryId === category.id &&
								"border-primary text-primary",
						)}
						onClick={() => setSelectedCategoryId(category.id)}
						onDragOver={(event) => event.preventDefault()}
						onDrop={(event) => void handleDropOnCategory({ category, event })}
						title="Drop a sound here to add it to this category"
					>
						<HugeiconsIcon icon={Folder03Icon} className="size-5" />
						<span className="max-w-full truncate text-xs">{category.name}</span>
						<span className="text-muted-foreground text-[10px]">
							{category.assetIds.length}
						</span>
					</button>
				))}
				<Dialog
					open={isCategoryDialogOpen}
					onOpenChange={setIsCategoryDialogOpen}
				>
					<DialogTrigger asChild>
						<button
							type="button"
							className="border-muted-foreground/30 text-muted-foreground hover:text-foreground flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-sm border border-dashed px-2 text-center"
						>
							<HugeiconsIcon icon={PlusSignIcon} className="size-5" />
							<span className="text-xs">Category</span>
						</button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Create category</DialogTitle>
							<DialogDescription>
								Categories are saved in the repository manifest and can contain
								the same file in many places.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<Input
								placeholder="Category name"
								value={categoryName}
								onChange={(event) => setCategoryName(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void handleCreateCategory();
									}
								}}
							/>
						</DialogBody>
						<DialogFooter>
							<Button
								variant="text"
								onClick={() => setIsCategoryDialogOpen(false)}
							>
								Cancel
							</Button>
							<Button onClick={() => void handleCreateCategory()}>
								Create
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			<div className="relative min-h-0 flex-1 overflow-hidden">
				<ScrollArea className="h-full flex-1">
					<div className="flex flex-col gap-3">
						{isLoading && folderAssets.length === 0 && (
							<div className="text-muted-foreground text-sm">
								Loading shared sounds...
							</div>
						)}
						{displayedAssets.map((asset) => (
							<SharedAudioItem
								key={asset.id}
								asset={asset}
								isPlaying={playingId === asset.id}
								onPlay={playAsset}
								onAddToTimeline={addSharedAudioToTimeline}
							/>
						))}
						{!isLoading && displayedAssets.length === 0 && (
							<div className="text-muted-foreground py-8 text-center text-sm">
								{selectedCategory
									? "Drop sounds into this category to show them here."
									: `Add ${folderLabel.toLowerCase()} to build your shared library.`}
							</div>
						)}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}

const SharedAudioItem = memo(function SharedAudioItem({
	asset,
	isPlaying,
	onPlay,
	onAddToTimeline,
}: {
	asset: SharedAudioAsset;
	isPlaying: boolean;
	onPlay: ({ asset }: { asset: SharedAudioAsset }) => void;
	onAddToTimeline: ({ asset }: { asset: SharedAudioAsset }) => Promise<boolean>;
}) {
	const handleDragStart = (event: React.DragEvent<HTMLDivElement>) => {
		event.dataTransfer.setData("application/x-shared-audio-asset-id", asset.id);
		event.dataTransfer.setData("text/plain", asset.name);
	};

	return (
		<div
			className="group flex items-center gap-3 opacity-100 hover:opacity-75"
			draggable
			onDragStart={handleDragStart}
		>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 text-left"
				onClick={() => onPlay({ asset })}
			>
				<div className="bg-accent relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
					<div className="from-primary/20 absolute inset-0 bg-gradient-to-br to-transparent" />
					{isPlaying ? (
						<HugeiconsIcon icon={PauseIcon} className="size-5" />
					) : (
						<HugeiconsIcon icon={PlayIcon} className="size-5" />
					)}
				</div>
				<div className="min-w-0 flex-1 overflow-hidden">
					<p className="truncate text-sm font-medium">{asset.name}</p>
					<span className="text-muted-foreground block truncate text-xs">
						{formatAudioDuration({ seconds: asset.duration })} ·{" "}
						{formatFileSize({ bytes: asset.size })}
					</span>
				</div>
			</button>
			<Button
				variant="text"
				size="icon"
				className="text-muted-foreground hover:text-foreground w-auto !opacity-100"
				onClick={(event) => {
					event.stopPropagation();
					void onAddToTimeline({ asset });
				}}
				title="Add to timeline"
			>
				<HugeiconsIcon icon={PlusSignIcon} />
			</Button>
		</div>
	);
});
SharedAudioItem.displayName = "SharedAudioItem";

function VirtualSoundList({
	sounds,
	playingId,
	onPlay,
	isLoadingMore = false,
	hasMore = false,
	isLoading = false,
	onLoadMore,
	initialScrollTop = 0,
	onScrollTopChange,
}: {
	sounds: SoundEffect[];
	playingId: number | null;
	onPlay: ({ sound }: { sound: SoundEffect }) => void;
	isLoadingMore?: boolean;
	hasMore?: boolean;
	isLoading?: boolean;
	onLoadMore?: () => void;
	initialScrollTop?: number;
	onScrollTopChange?: ({ scrollTop }: { scrollTop: number }) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<ListImperativeAPI | null>(null);
	const hasRestoredScrollRef = useRef(false);
	const { height: containerHeight } = useContainerSize({ containerRef });
	const rowCount = sounds.length + (isLoadingMore ? 1 : 0);
	const listHeight = Math.max(
		1,
		containerHeight || SOUND_LIST_FALLBACK_HEIGHT_PX,
	);

	useEffect(() => {
		if (hasRestoredScrollRef.current || initialScrollTop <= 0) {
			return;
		}

		const timeoutId = setTimeout(() => {
			listRef.current?.element?.scrollTo({ top: initialScrollTop });
			hasRestoredScrollRef.current = true;
		}, 0);

		return () => clearTimeout(timeoutId);
	}, [initialScrollTop]);

	const handleRowsRendered = useCallback(
		({ stopIndex }: { startIndex: number; stopIndex: number }) => {
			if (!onLoadMore || !hasMore || isLoading || isLoadingMore) {
				return;
			}

			if (stopIndex >= sounds.length - SOUND_LIST_LOAD_MORE_THRESHOLD_ROWS) {
				onLoadMore();
			}
		},
		[hasMore, isLoading, isLoadingMore, onLoadMore, sounds.length],
	);

	const handleScroll = useCallback(
		(event: React.UIEvent<HTMLDivElement>) => {
			onScrollTopChange?.({ scrollTop: event.currentTarget.scrollTop });
		},
		[onScrollTopChange],
	);

	if (rowCount === 0) {
		return null;
	}

	return (
		<div ref={containerRef} className="relative h-full overflow-hidden">
			<List
				className="scrollbar-thin"
				listRef={listRef}
				rowCount={rowCount}
				rowHeight={SOUND_ROW_HEIGHT_PX}
				overscanCount={SOUND_LIST_OVERSCAN_ROWS}
				onRowsRendered={handleRowsRendered}
				onScroll={handleScroll}
				rowComponent={VirtualSoundRow}
				rowProps={{
					isLoadingMore,
					onPlay,
					playingId,
					sounds,
				}}
				style={{ height: listHeight, width: "100%" }}
			/>
		</div>
	);
}

type VirtualSoundRowProps = {
	isLoadingMore: boolean;
	onPlay: ({ sound }: { sound: SoundEffect }) => void;
	playingId: number | null;
	sounds: SoundEffect[];
};

function VirtualSoundRow({
	index,
	style,
	isLoadingMore,
	onPlay,
	playingId,
	sounds,
}: RowComponentProps<VirtualSoundRowProps>) {
	const sound = sounds[index];
	if (!sound) {
		return isLoadingMore ? (
			<div
				className="text-muted-foreground flex items-center justify-center text-sm"
				style={style as CSSProperties}
			>
				Loading more sounds...
			</div>
		) : null;
	}

	return (
		<div className="pr-2" style={style as CSSProperties}>
			<AudioItem
				sound={sound}
				isPlaying={playingId === sound.id}
				onPlay={onPlay}
			/>
		</div>
	);
}

function SoundEffectsView() {
	const topSoundEffects = useSoundsStore((state) => state.topSoundEffects);
	const isLoading = useSoundsStore((state) => state.isLoading);
	const searchQuery = useSoundsStore((state) => state.searchQuery);
	const setSearchQuery = useSoundsStore((state) => state.setSearchQuery);
	const setScrollPosition = useSoundsStore((state) => state.setScrollPosition);
	const loadSavedSounds = useSoundsStore((state) => state.loadSavedSounds);
	const showCommercialOnly = useSoundsStore(
		(state) => state.showCommercialOnly,
	);
	const toggleCommercialFilter = useSoundsStore(
		(state) => state.toggleCommercialFilter,
	);
	const hasLoaded = useSoundsStore((state) => state.hasLoaded);
	const setTopSoundEffects = useSoundsStore(
		(state) => state.setTopSoundEffects,
	);
	const setLoading = useSoundsStore((state) => state.setLoading);
	const setError = useSoundsStore((state) => state.setError);
	const setHasLoaded = useSoundsStore((state) => state.setHasLoaded);
	const setCurrentPage = useSoundsStore((state) => state.setCurrentPage);
	const setHasNextPage = useSoundsStore((state) => state.setHasNextPage);
	const setTotalCount = useSoundsStore((state) => state.setTotalCount);
	const [initialScrollTop] = useState(
		() => useSoundsStore.getState().scrollPosition,
	);
	const {
		results: searchResults,
		isLoading: isSearching,
		loadMore,
		hasNextPage,
		isLoadingMore,
	} = useSoundSearch({
		query: searchQuery,
		commercialOnly: showCommercialOnly,
	});

	const [playingId, setPlayingId] = useState<number | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
		null,
	);

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	useEffect(() => {
		if (hasLoaded) {
			return;
		}

		let shouldIgnore = false;

		const fetchTopSounds = async () => {
			try {
				if (!shouldIgnore) {
					setLoading({ loading: true });
					setError({ error: null });
				}

				const response = await fetch(
					"/api/sounds/search?page_size=50&sort=downloads",
				);

				if (!shouldIgnore) {
					if (!response.ok) {
						throw new Error(`Failed to fetch: ${response.status}`);
					}

					const data = await response.json();
					setTopSoundEffects({ sounds: data.results });
					setHasLoaded({ loaded: true });

					setCurrentPage({ page: 1 });
					setHasNextPage({ hasNext: !!data.next });
					setTotalCount({ count: data.count });
				}
			} catch (error) {
				if (!shouldIgnore) {
					console.error("Failed to fetch top sounds:", error);
					setError({
						error:
							error instanceof Error ? error.message : "Failed to load sounds",
					});
				}
			} finally {
				if (!shouldIgnore) {
					setLoading({ loading: false });
				}
			}
		};

		const timeoutId = setTimeout(fetchTopSounds, 100, {});

		return () => {
			shouldIgnore = true;
			clearTimeout(timeoutId);
		};
	}, [
		hasLoaded,
		setTopSoundEffects,
		setLoading,
		setError,
		setHasLoaded,
		setCurrentPage,
		setHasNextPage,
		setTotalCount,
	]);

	const handleScrollTopChange = useCallback(
		({ scrollTop }: { scrollTop: number }) => {
			setScrollPosition({ position: scrollTop });
		},
		[setScrollPosition],
	);

	const displayedSounds = searchQuery ? searchResults : topSoundEffects;

	const playSound = useCallback(
		({ sound }: { sound: SoundEffect }) => {
			if (playingId === sound.id) {
				audioElement?.pause();
				setPlayingId(null);
				return;
			}

			audioElement?.pause();

			if (sound.previewUrl) {
				const audio = new Audio(sound.previewUrl);
				audio.addEventListener("ended", () => {
					setPlayingId(null);
				});
				audio.addEventListener("error", () => {
					setPlayingId(null);
				});
				audio.play().catch((error) => {
					console.error("Failed to play sound preview:", error);
					setPlayingId(null);
				});

				setAudioElement(audio);
				setPlayingId(sound.id);
			}
		},
		[audioElement, playingId],
	);

	const handleLoadMore = useCallback(() => {
		void loadMore();
	}, [loadMore]);

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center gap-3">
				<Input
					placeholder="Search sound effects"
					className="w-full"
					containerClassName="w-full"
					value={searchQuery}
					onChange={({ currentTarget }) =>
						setSearchQuery({ query: currentTarget.value })
					}
					showClearIcon
					onClear={() => setSearchQuery({ query: "" })}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="text"
							size="icon"
							className={cn(showCommercialOnly && "text-primary")}
						>
							<HugeiconsIcon icon={FilterMailIcon} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuCheckboxItem
							checked={showCommercialOnly}
							onCheckedChange={() => toggleCommercialFilter()}
						>
							Show only commercially licensed
						</DropdownMenuCheckboxItem>
						<div className="text-muted-foreground px-2 py-1.5 text-xs">
							{showCommercialOnly
								? "Only showing sounds licensed for commercial use"
								: "Showing all sounds regardless of license"}
						</div>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="relative h-full overflow-hidden">
				{isLoading && !searchQuery ? (
					<div className="text-muted-foreground text-sm">Loading sounds...</div>
				) : isSearching && searchQuery ? (
					<div className="text-muted-foreground text-sm">Searching...</div>
				) : displayedSounds.length > 0 ? (
					<VirtualSoundList
						sounds={displayedSounds}
						playingId={playingId}
						onPlay={playSound}
						isLoadingMore={isLoadingMore}
						hasMore={hasNextPage}
						isLoading={isSearching}
						onLoadMore={handleLoadMore}
						initialScrollTop={initialScrollTop}
						onScrollTopChange={handleScrollTopChange}
					/>
				) : (
					<div className="text-muted-foreground text-sm">
						{searchQuery ? "No sounds found" : "No sounds available"}
					</div>
				)}
			</div>
		</div>
	);
}

function SavedSoundsView() {
	const savedSounds = useSoundsStore((state) => state.savedSounds);
	const isLoadingSavedSounds = useSoundsStore(
		(state) => state.isLoadingSavedSounds,
	);
	const savedSoundsError = useSoundsStore((state) => state.savedSoundsError);
	const loadSavedSounds = useSoundsStore((state) => state.loadSavedSounds);
	const clearSavedSounds = useSoundsStore((state) => state.clearSavedSounds);

	const [playingId, setPlayingId] = useState<number | null>(null);
	const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
		null,
	);

	const [showClearDialog, setShowClearDialog] = useState(false);

	useEffect(() => {
		loadSavedSounds();
	}, [loadSavedSounds]);

	const playSound = useCallback(
		({ sound }: { sound: SoundEffect }) => {
			if (playingId === sound.id) {
				audioElement?.pause();
				setPlayingId(null);
				return;
			}

			audioElement?.pause();

			if (sound.previewUrl) {
				const audio = new Audio(sound.previewUrl);
				audio.addEventListener("ended", () => {
					setPlayingId(null);
				});
				audio.addEventListener("error", () => {
					setPlayingId(null);
				});
				audio.play().catch((error) => {
					console.error("Failed to play sound preview:", error);
					setPlayingId(null);
				});

				setAudioElement(audio);
				setPlayingId(sound.id);
			}
		},
		[audioElement, playingId],
	);
	const savedSoundEffects = useMemo(
		() =>
			savedSounds.map((savedSound) => savedSoundToSoundEffect({ savedSound })),
		[savedSounds],
	);

	if (isLoadingSavedSounds) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-muted-foreground text-sm">
					Loading saved sounds...
				</div>
			</div>
		);
	}

	if (savedSoundsError) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-destructive text-sm">
					Error: {savedSoundsError}
				</div>
			</div>
		);
	}

	if (savedSounds.length === 0) {
		return (
			<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
				<HugeiconsIcon
					icon={FavouriteIcon}
					className="text-muted-foreground size-10"
				/>
				<div className="flex flex-col gap-2 text-center">
					<p className="text-lg font-medium">No saved sounds</p>
					<p className="text-muted-foreground text-sm text-balance">
						Click the heart icon on any sound to save it here
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="mt-1 flex h-full flex-col gap-5">
			<div className="flex items-center justify-between">
				<p className="text-muted-foreground text-sm">
					{savedSounds.length} saved{" "}
					{savedSounds.length === 1 ? "sound" : "sounds"}
				</p>
				<Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
					<DialogTrigger asChild>
						<Button
							variant="text"
							size="sm"
							className="text-muted-foreground hover:text-destructive h-auto !opacity-100"
						>
							Clear all
						</Button>
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Clear all saved sounds?</DialogTitle>
							<DialogDescription>
								This will permanently remove all {savedSounds.length} saved
								sounds from your collection. This action cannot be undone.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="text" onClick={() => setShowClearDialog(false)}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								onClick={async ({
									stopPropagation,
								}: React.MouseEvent<HTMLButtonElement>) => {
									stopPropagation();
									await clearSavedSounds();
									setShowClearDialog(false);
								}}
							>
								Clear all sounds
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			<div className="relative h-full overflow-hidden">
				<VirtualSoundList
					sounds={savedSoundEffects}
					playingId={playingId}
					onPlay={playSound}
				/>
			</div>
		</div>
	);
}

interface AudioItemProps {
	sound: SoundEffect;
	isPlaying: boolean;
	onPlay: ({ sound }: { sound: SoundEffect }) => void;
}

const AudioItem = memo(function AudioItem({
	sound,
	isPlaying,
	onPlay,
}: AudioItemProps) {
	const addSoundToTimeline = useSoundsStore(
		(state) => state.addSoundToTimeline,
	);
	const toggleSavedSound = useSoundsStore((state) => state.toggleSavedSound);
	const isSaved = useSoundsStore((state) =>
		state.savedSounds.some((savedSound) => savedSound.id === sound.id),
	);

	const handleClick = () => {
		onPlay({ sound });
	};

	const handleSaveClick = ({
		stopPropagation,
	}: React.MouseEvent<HTMLButtonElement>) => {
		stopPropagation();
		toggleSavedSound({ soundEffect: sound });
	};

	const handleAddToTimeline = async ({
		stopPropagation,
	}: React.MouseEvent<HTMLButtonElement>) => {
		stopPropagation();
		await addSoundToTimeline({ sound });
	};

	return (
		<div className="group flex items-center gap-3 opacity-100 hover:opacity-75">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 text-left"
				onClick={handleClick}
			>
				<div className="bg-accent relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md">
					<div className="from-primary/20 absolute inset-0 bg-gradient-to-br to-transparent" />
					{isPlaying ? (
						<HugeiconsIcon icon={PauseIcon} className="size-5" />
					) : (
						<HugeiconsIcon icon={PlayIcon} className="size-5" />
					)}
				</div>

				<div className="min-w-0 flex-1 overflow-hidden">
					<p className="truncate text-sm font-medium">{sound.name}</p>
					<span className="text-muted-foreground block truncate text-xs">
						{sound.username}
					</span>
				</div>
			</button>

			<div className="flex items-center gap-3 pr-2">
				<Button
					variant="text"
					size="icon"
					className="text-muted-foreground hover:text-foreground w-auto !opacity-100"
					onClick={handleAddToTimeline}
					title="Add to timeline"
				>
					<HugeiconsIcon icon={PlusSignIcon} />
				</Button>
				<Button
					variant="text"
					size="icon"
					className={`hover:text-foreground w-auto !opacity-100 ${
						isSaved
							? "text-red-500 hover:text-red-600"
							: "text-muted-foreground"
					}`}
					onClick={handleSaveClick}
					title={isSaved ? "Remove from saved" : "Save sound"}
				>
					<HugeiconsIcon
						icon={FavouriteIcon}
						className={`${isSaved ? "fill-current" : ""}`}
					/>
				</Button>
			</div>
		</div>
	);
});
AudioItem.displayName = "AudioItem";
