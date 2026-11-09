"use client";

import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useState, useSyncExternalStore } from "react";
import { ChevronDown, Layers, Sparkles, X } from "lucide-react";
import { toast } from "@/i18n/toast";
import {
	useEditor,
	useEditorTimelineScenes,
	useEditorTimelineSelection,
} from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import type { SmartTakeMode } from "./types";
import { Spinner } from "@/components/ui/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	ContextMenuItem,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { getSmartTakesTask } from "@/ai/smart-takes-task";
import type { TimelineElement } from "@/timeline/types";

export function SmartTakesControl() {
	const editor = useEditor();
	const [mode, setMode] = useState<SmartTakeMode>("experimental");
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const selection = useEditorTimelineSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const task = getSmartTakesTask(editor);
	const status = useSyncExternalStore(
		task.subscribe,
		task.getSnapshot,
		task.getSnapshot,
	);
	const stage = status.status === "running" ? status.stage : null;
	const ids = selection
		.filter(
			(ref) =>
				ref.trackId === scene?.tracks.main.id &&
				scene.tracks.main.elements.some(
					(e) => e.id === ref.elementId && e.type === "video",
				),
		)
		.map((ref) => ref.elementId);
	const disabledReason = scene?.takeAssembly
		? "Right-click an assembled clip to choose a take"
		: !ids.length
			? "Select a video clip on the main track to use Smart takes"
			: null;
	const disabled = !!disabledReason;
	const run = () => {
		try {
			task.start({ elementIds: ids, requestId: crypto.randomUUID(), mode });
		} catch (error) {
			toast.error("Could not assemble takes", {
				description: error instanceof Error ? error.message : String(error),
				duration: Infinity,
				closeButton: true,
			});
		}
	};
	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<Button
							variant="outline"
							className="rounded-r-none"
							size="sm"
							disabled={disabled || !!stage}
							onClick={() => void run()}
							aria-label={
								disabledReason ??
								`Smart takes — ${mode === "experimental" ? "fast" : "classic"}`
							}
						>
							{stage ? (
								<Spinner className="size-3.5" />
							) : (
								<Sparkles className="size-3.5" />
							)}{" "}
							<UiMessage text={"Smart takes ·"} />{" "}
							{mode === "experimental" ? (
								<UiMessage text={"Fast"} />
							) : (
								<UiMessage text={"Classic"} />
							)}
						</Button>
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{disabledReason ?? (
						<UiMessage
							text={
								"Infer story order, remove filming notes and keep alternative takes. If needed, generate a transcript and Codex-correct it first."
							}
						/>
					)}
				</TooltipContent>
			</Tooltip>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["aria-label"]}
						variant="outline"
						size="sm"
						className="-ml-1 rounded-l-none px-2"
						disabled={!!stage}
						aria-label="Choose Smart takes mode"
					>
						<ChevronDown className="size-3.5" />
					</UiLocalized>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuRadioGroup
						value={mode}
						onValueChange={(value) => {
							if (value === "experimental" || value === "standard")
								setMode(value);
						}}
					>
						<DropdownMenuRadioItem value="experimental">
							<UiMessage text={"Fast · default"} />
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="standard">
							<UiMessage text={"Classic · slower"} />
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			{!stage && status.elapsedMs !== undefined && status.status !== "idle" && (
				<span
					className="text-xs text-muted-foreground"
					role="status"
					title={status.stageTimings
						?.map((s) => `${s.stage}: ${(s.durationMs / 1000).toFixed(1)}s`)
						.join("\n")}
				>
					{status.mode === "experimental" ? (
						<UiMessage text={"Fast"} />
					) : (
						<UiMessage text={"Classic"} />
					)}{" "}
					· {(status.elapsedMs / 1000).toFixed(1)}s
				</span>
			)}
			{stage && (
				<>
					<span
						className="max-w-64 truncate text-xs"
						role="status"
						aria-live="polite"
					>
						{stage}
					</span>
					<UiLocalized<typeof Button>
						element={Button}
						messageProps={["aria-label"]}
						variant="ghost"
						size="icon"
						aria-label="Cancel take analysis"
						onClick={() => task.cancel()}
					>
						<X />
					</UiLocalized>
				</>
			)}
		</div>
	);
}

export function SmartTakeMenu({ element }: { element: TimelineElement }) {
	const editor = useEditor();
	const assembly = useEditorTimelineScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.takeAssembly,
	);
	const ref = element.takeGroup;
	if (!assembly || !ref || ref.assemblyId !== assembly.id) return null;
	const group = assembly.plan.groups[ref.groupIndex];
	if (!group || group.alternatives.length < 2) return null;
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<Layers className="mr-2 size-4" />
				<UiMessage text={"Choose the best take ("} />
				{group.alternatives.length})
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="max-h-96 w-96 overflow-y-auto">
				<div className="px-3 py-2 text-xs text-muted-foreground" dir="auto">
					{group.label} ·{" "}
					{group.confidence < 0.75 ? (
						<UiMessage text={"Needs review"} />
					) : (
						<UiMessage text={"Transcript recommendation"} />
					)}
				</div>
				{group.alternatives.map((take, index) => {
					const words = take.parts.flatMap((part) =>
						assembly.sourceWords.slice(part.firstWord, part.lastWord + 1),
					);
					const duration = take.parts.reduce(
						(sum, part) =>
							sum +
							(assembly.sourceWords[part.lastWord].end -
								assembly.sourceWords[part.firstWord].start) /
								120000,
						0,
					);
					return (
						<ContextMenuItem
							key={index}
							disabled={group.selected === index}
							className="flex flex-col items-stretch gap-1 whitespace-normal p-3"
							onClick={() => {
								try {
									editor.command.selectSmartTake({
										groupIndex: ref.groupIndex,
										alternativeIndex: index,
									});
								} catch (error) {
									toast.error("Could not switch take", {
										description:
											error instanceof Error
												? error.message
												: "Please try again",
									});
								}
							}}
						>
							<span className="font-medium" dir="auto">
								{group.selected === index ? "✓ " : ""}
								{take.label}
								{assembly.recommendations[ref.groupIndex] === index ? (
									<>
										{" "}
										<UiMessage text={"· AI pick"} />
									</>
								) : (
									""
								)}
							</span>
							<span className="text-xs text-muted-foreground">
								{duration.toFixed(1)}s · {take.parts.length}{" "}
								{take.parts.length === 1 ? (
									<UiMessage text={"cut"} />
								) : (
									<UiMessage text={"cuts combined"} />
								)}
							</span>
							<span className="line-clamp-3 text-sm" dir="auto">
								{words.map((w) => w.text).join(" ")}
							</span>
							<span className="text-xs text-muted-foreground" dir="auto">
								{take.reason}
							</span>
						</ContextMenuItem>
					);
				})}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

export function SmartTakeBadge({ element }: { element: TimelineElement }) {
	const assembly = useEditorTimelineScenes(
		(e) => e.scenes.getActiveSceneOrNull()?.takeAssembly,
	);
	const ref = element.takeGroup;
	if (!ref || !assembly || ref.assemblyId !== assembly.id) return null;
	const group = assembly.plan.groups[ref.groupIndex];
	if (!group || group.alternatives.length < 2) return null;
	return (
		<UiLocalized<"span">
			element={"span"}
			messageProps={["title"]}
			className="pointer-events-none absolute right-1 bottom-1 z-10 flex items-center gap-1 rounded bg-black/75 px-1 text-[10px] text-white"
			title="Right-click to choose a take"
		>
			<Layers className="size-3" />
			{group.alternatives.length}
		</UiLocalized>
	);
}
