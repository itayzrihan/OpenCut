"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	useEditor,
	useEditorMedia,
	useEditorSelection,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { EmptyView } from "./empty-view";
import type { TextElement, TimelineElement } from "@/timeline";
import { getTextRows, getWordRuns, type TextOverrideScope } from "./text-scope";
import { useMemo, useState } from "react";
import type { SelectedTextWordRef } from "@/selection/editor-selection";
import type { ElementWithTrackForParams } from "./components/element-params-tab";

export function PropertiesPanel() {
	const editor = useEditor();
	useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const mediaAssets = useEditorMedia((e) => e.media.getAssets());
	const { selectedElements } = useElementSelection();
	const selectedTextWords = useEditorSelection((e) =>
		e.selection.getSelectedTextWords(),
	);
	const { activeTabPerType, setActiveTab } = usePropertiesStore();
	const elementsWithTracks = addSelectedTextWordIds({
		elementsWithTracks: editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		}),
		selectedTextWords,
	});
	const selectedTextWordCount = selectedTextWords.length;
	const [textScopeMode, setTextScopeMode] =
		useState<TextOverrideScope["type"]>("layer");
	const [selectedLineIndex, setSelectedLineIndex] = useState(0);
	const [selectedWordId, setSelectedWordId] = useState("");

	if (selectedElements.length === 0) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<EmptyView />
			</div>
		);
	}

	if (selectedElements.length > 1) {
		const firstElement = elementsWithTracks[0]?.element;
		const canBulkEdit =
			firstElement &&
			firstElement.type === "text" &&
			elementsWithTracks.length === selectedElements.length &&
			elementsWithTracks.every(
				(entry) => entry.element.type === firstElement.type,
			);

		if (!canBulkEdit || !firstElement) {
			return (
				<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
					<p className="text-muted-foreground text-sm">
						{selectedElements.length} elements selected
					</p>
				</div>
			);
		}

		const config = getPropertiesConfig({ element: firstElement, mediaAssets });
		const visibleTabs = config.tabs;
		const storedTabId = activeTabPerType[firstElement.type];
		const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
		const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
		const activeTab =
			visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];
		const trackId = elementsWithTracks[0].track.id;
		const textScope =
			selectedTextWordCount > 0
				? buildSelectedTextWordScope({ entry: elementsWithTracks[0] })
				: undefined;

		if (!activeTab) return null;

		return (
			<div className="panel bg-background flex h-full overflow-hidden rounded-sm border">
				<TooltipProvider delayDuration={0}>
					<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
						{visibleTabs.map((tab) => (
							<Tooltip key={tab.id}>
								<TooltipTrigger asChild>
									<Button
										variant={tab.id === activeTab.id ? "secondary" : "ghost"}
										size="icon"
										onClick={() =>
											setActiveTab({
												elementType: firstElement.type,
												tabId: tab.id,
											})
										}
										aria-label={tab.label}
										className={cn(
											"shrink-0",
											"h-8 w-8",
											tab.id !== activeTab.id && "text-muted-foreground",
										)}
									>
										{tab.icon}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="right">{tab.label}</TooltipContent>
							</Tooltip>
						))}
					</div>
				</TooltipProvider>
				<ScrollArea className="flex-1 scrollbar-hidden">
					<div className="border-b px-3 py-2 text-muted-foreground text-xs">
						{selectedTextWordCount > 0
							? `${selectedTextWordCount} words selected`
							: `${selectedElements.length} ${firstElement.type} elements selected`}
					</div>
					{activeTab.content({ trackId, elementsWithTracks, textScope })}
				</ScrollArea>
			</div>
		);
	}
	const elementWithTrack = elementsWithTracks[0];

	if (!elementWithTrack) return null;

	const { element, track } = elementWithTrack;
	const config = getPropertiesConfig({ element, mediaAssets });
	const visibleTabs = config.tabs;
	const selectedTextWordScope =
		selectedTextWordCount > 0
			? buildSelectedTextWordScope({ entry: elementWithTrack })
			: undefined;
	const textScope =
		selectedTextWordScope ??
		buildTextScope({
			element,
			mode: textScopeMode,
			selectedLineIndex,
			selectedWordId,
		});

	const storedTabId = activeTabPerType[element.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	return (
		<div className="panel bg-background flex h-full overflow-hidden rounded-sm border">
			<TooltipProvider delayDuration={0}>
				<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
					{visibleTabs.map((tab) => (
						<Tooltip key={tab.id}>
							<TooltipTrigger asChild>
								<Button
									variant={tab.id === activeTab.id ? "secondary" : "ghost"}
									size="icon"
									onClick={() =>
										setActiveTab({
											elementType: element.type,
											tabId: tab.id,
										})
									}
									aria-label={tab.label}
									className={cn(
										"shrink-0",
										"h-8 w-8",
										tab.id !== activeTab.id && "text-muted-foreground",
									)}
								>
									{tab.icon}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="right">{tab.label}</TooltipContent>
						</Tooltip>
					))}
				</div>
			</TooltipProvider>
			<ScrollArea className="flex-1 scrollbar-hidden">
				{element.type === "text" && (
					<TextScopeBar
						element={element}
						mode={textScopeMode}
						onModeChange={setTextScopeMode}
						selectedLineIndex={selectedLineIndex}
						onLineChange={setSelectedLineIndex}
						selectedWordId={selectedWordId}
						onWordChange={setSelectedWordId}
						selectedTextWordScope={selectedTextWordScope}
						selectedTextWordCount={selectedTextWordCount}
					/>
				)}
				{activeTab.content({
					trackId: track.id,
					elementsWithTracks,
					textScope,
				})}
			</ScrollArea>
		</div>
	);
}

function buildTextScope({
	element,
	mode,
	selectedLineIndex,
	selectedWordId,
}: {
	element: TimelineElement;
	mode: TextOverrideScope["type"];
	selectedLineIndex: number;
	selectedWordId: string;
}): TextOverrideScope | undefined {
	if (element.type !== "text") return undefined;
	if (mode === "row") {
		const rows = getTextRows({ wordRuns: getWordRuns({ element }) });
		const lineIndex = rows.some((row) => row.lineIndex === selectedLineIndex)
			? selectedLineIndex
			: (rows[0]?.lineIndex ?? 0);
		return { type: "row", lineIndex };
	}
	if (mode === "word") {
		const wordRuns = getWordRuns({ element });
		const wordId = wordRuns.some((word) => word.id === selectedWordId)
			? selectedWordId
			: (wordRuns[0]?.id ?? "");
		return { type: "word", wordId };
	}
	return { type: "layer" };
}

function addSelectedTextWordIds({
	elementsWithTracks,
	selectedTextWords,
}: {
	elementsWithTracks: Array<{
		track: ElementWithTrackForParams["track"];
		element: TimelineElement;
	}>;
	selectedTextWords: SelectedTextWordRef[];
}): ElementWithTrackForParams[] {
	if (selectedTextWords.length === 0) {
		return elementsWithTracks;
	}

	const wordIdsByElement = new Map<string, string[]>();
	for (const word of selectedTextWords) {
		const key = `${word.trackId}:${word.elementId}`;
		wordIdsByElement.set(key, [
			...(wordIdsByElement.get(key) ?? []),
			word.wordId,
		]);
	}

	return elementsWithTracks.map((entry) => ({
		...entry,
		textWordIds: wordIdsByElement.get(`${entry.track.id}:${entry.element.id}`),
	}));
}

function buildSelectedTextWordScope({
	entry,
}: {
	entry: ElementWithTrackForParams;
}): Extract<TextOverrideScope, { type: "word" | "words" }> | undefined {
	const wordIds = entry.textWordIds ?? [];
	if (wordIds.length === 0) return undefined;
	if (wordIds.length === 1) {
		return { type: "word", wordId: wordIds[0] };
	}
	return { type: "words", wordIds };
}

function TextScopeBar({
	element,
	mode,
	onModeChange,
	selectedLineIndex,
	onLineChange,
	selectedWordId,
	onWordChange,
	selectedTextWordScope,
	selectedTextWordCount,
}: {
	element: TextElement;
	mode: TextOverrideScope["type"];
	onModeChange: (mode: TextOverrideScope["type"]) => void;
	selectedLineIndex: number;
	onLineChange: (lineIndex: number) => void;
	selectedWordId: string;
	onWordChange: (wordId: string) => void;
	selectedTextWordScope?: Extract<
		TextOverrideScope,
		{ type: "word" | "words" }
	>;
	selectedTextWordCount: number;
}) {
	const wordRuns = useMemo(() => getWordRuns({ element }), [element]);
	const rows = useMemo(() => getTextRows({ wordRuns }), [wordRuns]);
	const firstWordId = wordRuns[0]?.id ?? "";
	const effectiveWordId = selectedWordId || firstWordId;
	const effectiveLineIndex = rows.some(
		(row) => row.lineIndex === selectedLineIndex,
	)
		? selectedLineIndex
		: (rows[0]?.lineIndex ?? 0);
	const selectedTextWordLabel =
		selectedTextWordScope?.type === "word"
			? (wordRuns.find((word) => word.id === selectedTextWordScope.wordId)
					?.text ?? "Word")
			: `${selectedTextWordCount} words selected`;

	if (selectedTextWordScope) {
		return (
			<div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-xs">Scope</span>
					<Select value="word" disabled>
						<SelectTrigger className="h-8 min-w-28">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="word">Word</SelectItem>
						</SelectContent>
					</Select>
					<div className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
						{selectedTextWordLabel}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground text-xs">Scope</span>
				<Select
					value={mode}
					onValueChange={(value) =>
						onModeChange(value === "row" || value === "word" ? value : "layer")
					}
				>
					<SelectTrigger className="h-8 min-w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="layer">Layer</SelectItem>
						<SelectItem value="row">Row</SelectItem>
						<SelectItem value="word">Word</SelectItem>
					</SelectContent>
				</Select>
				{mode === "row" && (
					<Select
						value={String(effectiveLineIndex)}
						onValueChange={(value) => onLineChange(Number(value))}
					>
						<SelectTrigger className="h-8 min-w-0 flex-1">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{rows.map((row) => (
								<SelectItem key={row.lineIndex} value={String(row.lineIndex)}>
									{row.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				{mode === "word" && (
					<Select value={effectiveWordId} onValueChange={onWordChange}>
						<SelectTrigger className="h-8 min-w-0 flex-1">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{wordRuns.map((word) => (
								<SelectItem key={word.id} value={word.id}>
									{`Row ${word.lineIndex + 1}: ${word.text}`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</div>
		</div>
	);
}
