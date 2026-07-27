"use client";

import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { List, type RowComponentProps } from "react-window";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { loadFullFont } from "@/fonts/google-fonts";
import { CUSTOM_FONT_ACCEPT, loadProjectFont } from "@/fonts/custom-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import { loadTypekitFont, loadTypekitFonts } from "@/fonts/typekit-fonts";
import type { FontAtlas, FontAtlasEntry } from "@/fonts/types";
import { useFontAtlas } from "@/fonts/use-font-atlas";
import { cn } from "@/utils/ui";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { ChevronDown, Loader2, Search, Upload } from "lucide-react";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextIcon } from "@hugeicons/core-free-icons";

const FONT_TABS = [
	{ key: "all", label: "All fonts" },
	{ key: "adobe", label: "Adobe" },
	{ key: "my-fonts", label: "My fonts" },
	{ key: "favorites", label: "Favorites" },
] as const;

type FontTab = (typeof FONT_TABS)[number]["key"];

const ROW_HEIGHT = 40;
const PREVIEW_SCALE = 0.8;
const LIST_WIDTH = 288;
const MAX_LIST_HEIGHT = 288;
const OVERSCAN = 15;

interface FontPickerProps {
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	className?: string;
}

export function FontPicker({
	defaultValue,
	onValueChange,
	className,
}: FontPickerProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [activeTab, setActiveTab] = useState<FontTab>("all");
	const [isImporting, setIsImporting] = useState(false);
	const [typekitStatus, setTypekitStatus] = useState<
		"idle" | "loading" | "error"
	>("loading");
	const [typekitFontNames, setTypekitFontNames] = useState<string[]>([]);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const fontInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();
	const customFonts = useEditorProject(
		(e) => e.project.getActiveOrNull()?.customFonts ?? [],
	);
	const {
		atlas,
		status,
		fontNames: atlasFontNames,
		retry: handleRetry,
	} = useFontAtlas({ open });
	const customFontNames = useMemo(
		() => customFonts.map((font) => font.family).sort(),
		[customFonts],
	);
	const customFontByFamily = useMemo(
		() => new Map(customFonts.map((font) => [font.family, font])),
		[customFonts],
	);
	const customFontNameSet = useMemo(
		() => new Set(customFontNames),
		[customFontNames],
	);
	const typekitFontNameSet = useMemo(
		() => new Set(typekitFontNames),
		[typekitFontNames],
	);
	const fontNames = useMemo(() => {
		if (activeTab === "my-fonts") return customFontNames;
		if (activeTab === "favorites") return [];
		if (activeTab === "adobe") return typekitFontNames;
		return Array.from(
			new Set([...customFontNames, ...typekitFontNames, ...atlasFontNames]),
		).sort();
	}, [activeTab, atlasFontNames, customFontNames, typekitFontNames]);

	const filteredFonts = useMemo(() => {
		if (!search) return fontNames;
		const query = search.toLowerCase();
		return fontNames.filter((name) => name.toLowerCase().includes(query));
	}, [fontNames, search]);

	const listHeight = Math.min(
		MAX_LIST_HEIGHT,
		filteredFonts.length * ROW_HEIGHT,
	);

	const resetPicker = useCallback(() => {
		setSearch("");
		setActiveTab("all");
	}, []);

	const closePicker = useCallback(() => {
		setOpen(false);
		resetPicker();
	}, [resetPicker]);

	useEffect(() => {
		if (!open) return;

		let isCancelled = false;
		setTypekitStatus("loading");
		loadTypekitFonts({ refresh: true }).then((fonts) => {
			if (isCancelled) return;
			setTypekitFontNames(fonts.map((font) => font.family));
			setTypekitStatus(fonts.length > 0 ? "idle" : "error");
		});

		return () => {
			isCancelled = true;
		};
	}, [open]);

	const handleSelect = useCallback(
		async ({ family }: { family: string }) => {
			const customFont = customFontByFamily.get(family);
			if (customFont) {
				try {
					await loadProjectFont({ font: customFont });
				} catch {
					// ignore load failure, font will fall back to system default
				}
			} else if (typekitFontNameSet.has(family)) {
				await loadTypekitFont({ family });
			} else if (!SYSTEM_FONTS.has(family)) {
				try {
					await loadFullFont({ family });
				} catch {
					// ignore load failure, font will fall back to system default
				}
			}
			onValueChange?.(family);
			closePicker();
		},
		[closePicker, customFontByFamily, onValueChange, typekitFontNameSet],
	);

	const handleImportFonts = useCallback(
		async ({ files }: { files: File[] }) => {
			if (files.length === 0) return;

			setIsImporting(true);
			try {
				const importedFonts = await editor.project.importCustomFonts({ files });
				const firstImportedFont = importedFonts[0];
				if (firstImportedFont) {
					onValueChange?.(firstImportedFont.family);
					closePicker();
				}
			} finally {
				setIsImporting(false);
				if (fontInputRef.current) {
					fontInputRef.current.value = "";
				}
			}
		},
		[closePicker, editor, onValueChange],
	);

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			setOpen(nextOpen);
			if (!nextOpen) {
				resetPicker();
			}
		},
		[resetPicker],
	);

	const activeTabLabel =
		FONT_TABS.find((t) => t.key === activeTab)?.label.toLowerCase() ?? "";

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger
				className={cn(
					"border-border bg-accent flex h-7 w-full cursor-pointer items-center justify-between gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap focus-visible:border-primary focus-visible:ring-0 focus:outline-hidden",
					className,
				)}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="text-muted-foreground [&_svg]:size-3.5 shrink-0">
						<HugeiconsIcon icon={TextIcon} />
					</span>
					<span className="truncate" style={{ fontFamily: defaultValue }}>
						{defaultValue ?? "Select a font"}
					</span>
				</div>
				<ChevronDown className="size-3 shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent
				className="w-72 p-0 overflow-hidden"
				align="start"
				side="left"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					searchInputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<div className="relative px-3 py-1.5">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 shrink-0 opacity-50" />
					<Input
						ref={searchInputRef}
						placeholder={`Search ${activeTabLabel}...`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						size="xs"
						className="w-full pl-5 bg-transparent border-none! shadow-none!"
					/>
				</div>
				<div className="flex border-b px-3">
					{FONT_TABS.map((tab) => (
						<button
							key={tab.key}
							type="button"
							className={cn(
								"px-3 py-1.5 text-xs border-b-2 -mb-px",
								activeTab === tab.key
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
							onClick={() => setActiveTab(tab.key)}
						>
							{tab.label}
						</button>
					))}
				</div>
				{activeTab === "my-fonts" && (
					<div className="border-b px-3 py-2">
						<input
							ref={fontInputRef}
							type="file"
							accept={CUSTOM_FONT_ACCEPT}
							multiple
							className="hidden"
							onChange={(event) =>
								void handleImportFonts({
									files: Array.from(event.currentTarget.files ?? []),
								})
							}
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 w-full"
							disabled={isImporting}
							onClick={() => fontInputRef.current?.click()}
						>
							{isImporting ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Upload className="size-3.5" />
							)}
							Import fonts
						</Button>
					</div>
				)}
				{status === "loading" && activeTab === "all" && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						Loading fonts...
					</div>
				)}
				{status === "error" &&
					activeTab === "all" &&
					filteredFonts.length === 0 && (
						<div className="flex flex-col items-center gap-3 py-8 px-4">
							<p className="text-sm text-muted-foreground text-center">
								Failed to load font previews.
							</p>
							<Button variant="outline" size="sm" onClick={handleRetry}>
								Retry
							</Button>
						</div>
					)}
				{(status === "idle" || activeTab !== "all") &&
					fontNames.length > 0 &&
					filteredFonts.length === 0 && (
						<div className="py-6 text-center text-sm text-muted-foreground">
							No fonts found.
						</div>
					)}
				{activeTab === "my-fonts" && fontNames.length === 0 && (
					<div className="py-6 text-center text-sm text-muted-foreground">
						No fonts imported.
					</div>
				)}
				{activeTab === "adobe" &&
					typekitStatus === "loading" &&
					fontNames.length === 0 && (
						<div className="py-8 text-center text-sm text-muted-foreground">
							Loading Adobe fonts...
						</div>
					)}
				{activeTab === "adobe" &&
					typekitStatus === "error" &&
					fontNames.length === 0 && (
						<div className="py-6 text-center text-sm text-muted-foreground">
							No Adobe fonts found.
						</div>
					)}
				{(status === "idle" ||
					activeTab !== "all" ||
					filteredFonts.length > 0) &&
					filteredFonts.length > 0 && (
						<List
							rowCount={filteredFonts.length}
							rowHeight={ROW_HEIGHT}
							overscanCount={OVERSCAN}
							rowComponent={FontRow}
							rowProps={{
								atlas,
								customFontNameSet,
								filteredFonts,
								selectedFont: defaultValue,
								typekitFontNameSet,
								onFontSelect: handleSelect,
							}}
							style={{ height: listHeight, width: LIST_WIDTH }}
						/>
					)}
			</PopoverContent>
		</Popover>
	);
}

function FontSpritePreview({ entry }: { entry: FontAtlasEntry }) {
	return (
		<div
			className="shrink-0"
			style={{
				width: entry.w,
				height: ROW_HEIGHT,
				backgroundColor: "currentColor",
				WebkitMaskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				WebkitMaskPosition: `-${entry.x}px -${entry.y}px`,
				WebkitMaskRepeat: "no-repeat",
				maskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				maskPosition: `-${entry.x}px -${entry.y}px`,
				maskRepeat: "no-repeat",
				transform: `scale(${PREVIEW_SCALE})`,
				transformOrigin: "left center",
			}}
		/>
	);
}

type FontRowProps = {
	atlas: FontAtlas | null;
	customFontNameSet: Set<string>;
	filteredFonts: string[];
	selectedFont: string | undefined;
	typekitFontNameSet: Set<string>;
	onFontSelect: (params: { family: string }) => void;
};

function FontRow({
	index,
	style,
	atlas,
	customFontNameSet,
	filteredFonts,
	selectedFont,
	typekitFontNameSet,
	onFontSelect,
}: RowComponentProps<FontRowProps>) {
	const fontName = filteredFonts[index];
	const entry = atlas?.fonts[fontName];
	const isSelected = fontName === selectedFont;
	const isSystemFont = SYSTEM_FONTS.has(fontName);
	const isCustomFont = customFontNameSet.has(fontName);
	const isTypekitFont = typekitFontNameSet.has(fontName);

	return (
		<button
			type="button"
			style={style as CSSProperties}
			className={cn(
				"flex w-full cursor-pointer items-center gap-2 px-3 outline-hidden hover:bg-popover-hover",
				isSelected && "bg-popover-hover",
			)}
			onClick={() => onFontSelect({ family: fontName })}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onFontSelect({ family: fontName });
				}
			}}
			aria-label={fontName}
		>
			<div className="min-w-0 overflow-hidden">
				{isSystemFont || isCustomFont || isTypekitFont || !entry ? (
					<span
						className="text-xl text-foreground/85"
						style={{ fontFamily: fontName }}
					>
						{fontName}
					</span>
				) : (
					<FontSpritePreview entry={entry} />
				)}
			</div>
		</button>
	);
}
