"use client";

import Image from "next/image";
import type { CSSProperties } from "react";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEditor } from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";
import { resolveStickerIntrinsicSize } from "@/stickers";
import {
	buildGraphicElement,
	buildStickerElement,
} from "@/timeline/element-utils";
import { STICKER_CATEGORIES } from "@/stickers/categories";
import {
	getRegionLabel,
	resolveQueryToRegions,
	resolveStickerId,
} from "@/stickers";
import { parseShapeStickerId } from "@/stickers/providers/shapes";
import { parseStickerId } from "@/stickers/sticker-id";
import {
	useSharedLibraryStore,
	type SharedAssetCategory,
} from "@/shared-library";
import type { TimelineDragData } from "@/timeline/drag";
import type {
	StickerBrowseSection,
	StickerCategory,
	StickerItem as StickerData,
} from "@/stickers";
import { useStickersStore } from "@/stickers/stickers-store";
import { cn } from "@/utils/ui";
import {
	Folder03Icon,
	HappyIcon,
	PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

const STICKER_LAZY_MOUNT_THRESHOLD = 48;
const STICKER_LAZY_MOUNT_ROOT_MARGIN = "720px";

function isStickerCategory(value: string): value is StickerCategory {
	return value in STICKER_CATEGORIES;
}

export function StickersView() {
	const {
		browseContent,
		browseStickers,
		searchQuery,
		searchStickers,
		selectedCategory,
		setSearchQuery,
		setSelectedCategory,
		viewMode,
	} = useStickersStore();
	const {
		categories,
		createCategory,
		addAssetToCategory,
		importStickerFiles,
		loadLibrary,
		stickerAssets,
	} = useSharedLibraryStore();
	const [selectedCustomCategoryId, setSelectedCustomCategoryId] = useState<
		string | null
	>(null);
	const [categoryName, setCategoryName] = useState("");
	const [isCategoryDialogOpen, setIsCategoryDialogOpen] = useState(false);
	const stickerCategories = categories.filter(
		(category) => category.scope === "stickers",
	);
	const selectedCustomCategory = selectedCustomCategoryId
		? stickerCategories.find(
				(category) => category.id === selectedCustomCategoryId,
			)
		: null;
	const { openFilePicker, fileInputProps } = useFileUpload({
		accept: "image/*",
		multiple: true,
		onFilesSelected: (files) => {
			void importStickerFiles({ files }).then(() => {
				void browseStickers();
			});
		},
	});

	useEffect(() => {
		if (viewMode === "browse" && !browseContent) {
			void browseStickers();
		}
	}, [browseContent, browseStickers, viewMode]);

	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);

	const handleCreateCategory = async () => {
		const category = await createCategory({
			scope: "stickers",
			name: categoryName,
		});
		if (category) {
			setSelectedCustomCategoryId(category.id);
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
		const stickerId = event.dataTransfer.getData("application/x-sticker-id");
		if (!stickerId) return;
		await addAssetToCategory({
			categoryId: category.id,
			assetId: stickerId,
		});
	};

	return (
		<div className="flex h-full flex-col py-2">
			<input {...fileInputProps} />
			<div className="flex items-center gap-2 px-2">
				<Input
					size="sm"
					variant="default"
					placeholder="Search..."
					value={searchQuery}
					onChange={(e) => {
						setSelectedCustomCategoryId(null);
						setSearchQuery({ query: e.target.value });
						void searchStickers({ query: e.target.value });
					}}
					showClearIcon
					onClear={() => {
						setSearchQuery({ query: "" });
						void searchStickers({ query: "" });
					}}
					className="w-full"
					containerClassName="w-full"
				/>
				<Button size="sm" onClick={openFilePicker}>
					<HugeiconsIcon icon={PlusSignIcon} />
					Add
				</Button>
			</div>

			<div className="mt-2 flex gap-2 overflow-x-auto px-2 pb-1 scrollbar-hidden">
				<button
					type="button"
					className={cn(
						"bg-accent flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-sm border px-2 text-center",
						!selectedCustomCategoryId && "border-primary text-primary",
					)}
					onClick={() => setSelectedCustomCategoryId(null)}
				>
					<HugeiconsIcon icon={HappyIcon} className="size-5" />
					<span className="max-w-full truncate text-xs">All</span>
				</button>
				{stickerCategories.map((category) => (
					<button
						key={category.id}
						type="button"
						className={cn(
							"bg-accent flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-sm border px-2 text-center",
							selectedCustomCategoryId === category.id &&
								"border-primary text-primary",
						)}
						onClick={() => setSelectedCustomCategoryId(category.id)}
						onDragOver={(event) => event.preventDefault()}
						onDrop={(event) => void handleDropOnCategory({ category, event })}
						title="Drop a sticker here to add it to this category"
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
							<DialogTitle>Create sticker category</DialogTitle>
							<DialogDescription>
								Categories are saved in the repository manifest. A sticker can
								be dropped into multiple categories and still remain in the main
								sticker views.
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

			{selectedCustomCategory ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
					<CustomStickerCategoryView
						category={selectedCustomCategory}
						stickerAssets={stickerAssets}
					/>
				</div>
			) : (
				<Tabs
					value={selectedCategory}
					onValueChange={(value) => {
						if (!isStickerCategory(value)) {
							return;
						}
						setSelectedCustomCategoryId(null);
						setSelectedCategory({ category: value });
					}}
					variant="underline"
					className="mt-2 flex min-h-0 flex-1 flex-col"
				>
					<TabsList aria-label="Sticker categories">
						{Object.entries(STICKER_CATEGORIES).map(([key, label]) => (
							<TabsTrigger key={key} value={key}>
								{label}
							</TabsTrigger>
						))}
					</TabsList>
					<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
						<StickersContentView />
					</div>
				</Tabs>
			)}
		</div>
	);
}

function CustomStickerCategoryView({
	category,
	stickerAssets,
}: {
	category: SharedAssetCategory;
	stickerAssets: ReturnType<
		typeof useSharedLibraryStore.getState
	>["stickerAssets"];
}) {
	const importedById = new Map(stickerAssets.map((asset) => [asset.id, asset]));
	const items = category.assetIds
		.map((stickerId) => {
			try {
				const parsed = parseStickerId({ stickerId });
				const imported =
					parsed.providerId === "user-stickers"
						? importedById.get(parsed.providerValue)
						: null;
				if (imported) {
					const previewUrl = imported.dataUrl ?? imported.sourceUrl;
					if (!previewUrl) {
						return null;
					}
					return {
						id: stickerId,
						provider: parsed.providerId,
						name: imported.name,
						previewUrl,
						metadata: {
							sharedAssetId: imported.id,
						},
					} satisfies StickerData;
				}
				return {
					id: stickerId,
					provider: parsed.providerId,
					name: parsed.providerValue.replaceAll("-", " "),
					previewUrl: resolveStickerId({
						stickerId,
						options: { width: 96, height: 96 },
					}),
					metadata: {},
				} satisfies StickerData;
			} catch {
				return null;
			}
		})
		.filter((item): item is StickerData => item !== null);

	if (items.length === 0) {
		return (
			<EmptyView message="Drop stickers into this category to show them here." />
		);
	}

	return (
		<div className="flex flex-col gap-3 pb-4">
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground text-sm">
					{items.length} {items.length === 1 ? "sticker" : "stickers"}
				</span>
			</div>
			<StickerGrid items={items} />
		</div>
	);
}

function StickerGrid({
	items,
	shouldCapSize = false,
}: {
	items: StickerData[];
	shouldCapSize?: boolean;
}) {
	const shouldLazyMount = items.length > STICKER_LAZY_MOUNT_THRESHOLD;
	const gridStyle: CSSProperties & {
		"--sticker-min": string;
		"--sticker-max"?: string;
	} = {
		gridTemplateColumns: shouldCapSize
			? "repeat(auto-fill, minmax(var(--sticker-min, 80px), var(--sticker-max, 140px)))"
			: "repeat(auto-fill, minmax(var(--sticker-min, 80px), 1fr))",
		"--sticker-min": "80px",
		...(shouldCapSize ? { "--sticker-max": "140px" } : {}),
	};

	return (
		<div className="grid gap-2" style={gridStyle}>
			{items.map((item) => (
				<LazyStickerItem
					key={item.id}
					item={item}
					shouldCapSize={shouldCapSize}
					shouldLazyMount={shouldLazyMount}
				/>
			))}
		</div>
	);
}

function StickerRow({ items }: { items: StickerData[] }) {
	const shouldLazyMount = items.length > STICKER_LAZY_MOUNT_THRESHOLD;

	return (
		<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hidden">
			{items.map((item) => (
				<div key={item.id} className="w-20 shrink-0">
					<LazyStickerItem
						item={item}
						shouldCapSize
						containerClassName="w-full"
						shouldLazyMount={shouldLazyMount}
					/>
				</div>
			))}
		</div>
	);
}

const LazyStickerItem = memo(function LazyStickerItem({
	item,
	shouldCapSize = false,
	containerClassName,
	shouldLazyMount,
}: StickerItemProps & { shouldLazyMount: boolean }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [shouldMount, setShouldMount] = useState(!shouldLazyMount);

	useEffect(() => {
		if (shouldMount) {
			return;
		}

		const container = containerRef.current;
		if (!container || typeof IntersectionObserver === "undefined") {
			setShouldMount(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) {
					return;
				}
				setShouldMount(true);
				observer.disconnect();
			},
			{ rootMargin: STICKER_LAZY_MOUNT_ROOT_MARGIN },
		);
		observer.observe(container);

		return () => observer.disconnect();
	}, [shouldMount]);

	if (shouldMount) {
		return (
			<StickerItem
				item={item}
				shouldCapSize={shouldCapSize}
				containerClassName={containerClassName}
			/>
		);
	}

	return (
		<div
			ref={containerRef}
			className={cn("relative", containerClassName ?? "w-full")}
		>
			<div className="aspect-square w-full rounded-sm border bg-accent/45" />
		</div>
	);
});
LazyStickerItem.displayName = "LazyStickerItem";

function EmptyView({ message }: { message: string }) {
	return (
		<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
			<HugeiconsIcon
				icon={HappyIcon}
				className="text-muted-foreground size-10"
			/>
			<div className="flex flex-col gap-2 text-center">
				<p className="text-lg font-medium">No stickers found</p>
				<p className="text-muted-foreground text-sm text-balance">{message}</p>
			</div>
		</div>
	);
}

function RegionBanner({ region }: { region: string }) {
	return (
		<div className="flex h-7 items-center gap-1.5 rounded-lg border border-sky-100 bg-sky-50 px-2">
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				className="shrink-0 text-sky-600"
				aria-hidden="true"
			>
				<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
				<circle cx="12" cy="10" r="3" />
			</svg>
			<span className="text-xs font-semibold text-sky-600">{region}</span>
		</div>
	);
}

function StickersContentView() {
	const {
		browseContent,
		clearRecentStickers,
		isBrowsing,
		isSearching,
		searchQuery,
		searchResults,
		selectedCategory,
		setSelectedCategory,
		viewMode,
	} = useStickersStore();

	if (viewMode === "search") {
		if (isSearching) {
			return (
				<div className="flex items-center justify-center py-8">
					<Spinner className="text-muted-foreground size-6" />
				</div>
			);
		}

		if (searchResults?.items.length) {
			const normalizedQuery = searchQuery.trim().toLowerCase();
			const isRegionSearch =
				selectedCategory === "flags" &&
				resolveQueryToRegions({ query: normalizedQuery }) !== null;
			const regionLabel = getRegionLabel({ query: normalizedQuery });

			return (
				<div className="flex flex-col gap-3 pb-4">
					{isRegionSearch && <RegionBanner region={regionLabel} />}
					<div className="flex items-center justify-between">
						<span className="text-muted-foreground text-sm">
							{searchResults.total} results
						</span>
					</div>
					<StickerGrid items={searchResults.items} />
				</div>
			);
		}

		// "all" tab search — sections are in browseContent, fall through to section rendering below
		if (selectedCategory !== "all" && searchQuery) {
			return <EmptyView message={`No stickers found for "${searchQuery}"`} />;
		}
	}

	if (isBrowsing && !browseContent) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="text-muted-foreground size-6" />
			</div>
		);
	}

	if (!browseContent?.sections.length) {
		const categoryLabel = STICKER_CATEGORIES[selectedCategory];
		return (
			<EmptyView
				message={
					viewMode === "search"
						? `No stickers found for "${searchQuery}"`
						: selectedCategory === "all"
							? "No stickers available yet."
							: `No stickers available in ${categoryLabel.toLowerCase()} yet.`
				}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-4 pb-4">
			{browseContent.sections.map((section) => (
				<StickerSection
					key={section.id}
					section={section}
					onClearRecent={clearRecentStickers}
					onSeeAll={(category) => {
						setSelectedCategory({ category });
					}}
				/>
			))}
		</div>
	);
}

function StickerSection({
	section,
	onClearRecent,
	onSeeAll,
}: {
	section: StickerBrowseSection;
	onClearRecent: () => void;
	onSeeAll: (category: StickerCategory) => void;
}) {
	const hasHeader =
		Boolean(section.title) || section.id === "recent" || section.action;

	return (
		<div className="flex flex-col gap-2">
			{hasHeader && (
				<div className="flex items-center justify-between gap-2">
					{section.title ? (
						<p className="text-xs text-muted-foreground">{section.title}</p>
					) : (
						<div />
					)}

					<div className="ml-auto flex items-center gap-2">
						{section.id === "recent" && (
							<Button
								onClick={onClearRecent}
								variant="text"
								size="sm"
								className="h-auto gap-1 p-0 text-xs text-muted-foreground"
							>
								Clear
							</Button>
						)}

						{section.action?.type === "see-all" && section.action.category && (
							<Button
								variant="text"
								size="sm"
								className="h-auto gap-1 p-0 text-xs text-primary"
								onClick={() => {
									if (section.action?.category) {
										onSeeAll(section.action.category);
									}
								}}
							>
								See all
							</Button>
						)}
					</div>
				</div>
			)}

			{section.layout === "row" ? (
				<StickerRow items={section.items} />
			) : (
				<StickerGrid items={section.items} />
			)}
		</div>
	);
}

interface StickerItemProps {
	item: StickerData;
	shouldCapSize?: boolean;
	containerClassName?: string;
}

const StickerItem = memo(function StickerItem({
	item,
	shouldCapSize = false,
	containerClassName,
}: StickerItemProps) {
	const editor = useEditor();
	const { addToRecentStickers } = useStickersStore();
	const [isAdding, setIsAdding] = useState(false);
	const [imageErrorId, setImageErrorId] = useState<string | null>(null);
	const hasImageError = imageErrorId === item.id;

	const displayName = item.name;
	const shapePreset =
		item.provider === "shapes"
			? parseShapeStickerId({ stickerId: item.id })
			: null;

	const handleAdd = async () => {
		setIsAdding(true);
		try {
			const currentTime = editor.playback.getCurrentTime();

			let element:
				| ReturnType<typeof buildGraphicElement>
				| ReturnType<typeof buildStickerElement>;
			if (shapePreset) {
				element = buildGraphicElement({
					definitionId: shapePreset.definitionId,
					name: shapePreset.name,
					startTime: currentTime,
					params: shapePreset.params,
				});
			} else {
				const { width: intrinsicWidth, height: intrinsicHeight } =
					await resolveStickerIntrinsicSize({ stickerId: item.id });
				element = buildStickerElement({
					stickerId: item.id,
					name: item.name,
					startTime: currentTime,
					intrinsicWidth,
					intrinsicHeight,
				});
			}

			editor.timeline.insertElement({
				placement: { mode: "auto" },
				element,
			});

			addToRecentStickers({ stickerId: item.id });
		} catch (error) {
			console.error("Failed to add sticker:", error);
			toast.error("Failed to add sticker to timeline");
		} finally {
			setIsAdding(false);
		}
	};

	const preview = (
		<div className="flex size-full items-center justify-center p-3">
			{hasImageError ? (
				<span className="text-muted-foreground text-center text-xs break-all">
					{displayName}
				</span>
			) : (
				<Image
					src={item.previewUrl}
					alt={displayName}
					width={64}
					height={64}
					className="size-full object-contain"
					style={
						shouldCapSize
							? {
									maxWidth: "var(--sticker-max, 160px)",
									maxHeight: "var(--sticker-max, 160px)",
								}
							: undefined
					}
					onError={() => setImageErrorId(item.id)}
					loading="lazy"
					unoptimized
				/>
			)}
		</div>
	);

	const dragData: TimelineDragData = shapePreset
		? {
				id: item.id,
				type: "graphic",
				name: displayName,
				definitionId: shapePreset.definitionId,
				params: shapePreset.params ?? {},
			}
		: {
				id: item.id,
				type: "sticker",
				name: displayName,
				stickerId: item.id,
			};

	return (
		<div
			className={cn("relative", isAdding && "pointer-events-none opacity-50")}
		>
			<DraggableItem
				name={displayName}
				preview={preview}
				dragData={dragData}
				onDragStart={({ e }) => {
					e.dataTransfer.setData("application/x-sticker-id", item.id);
					e.dataTransfer.setData("text/plain", displayName);
				}}
				onAddToTimeline={handleAdd}
				aspectRatio={1}
				shouldShowLabel={false}
				isRounded
				variant="card"
				containerClassName={containerClassName ?? "w-full"}
			/>
			{isAdding && (
				<div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/60">
					<Spinner className="size-6 text-white" />
				</div>
			)}
		</div>
	);
});
StickerItem.displayName = "StickerItem";
