"use client";

import { useEffect, useRef, useState } from "react";
import { Layers, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import {
	useEditor,
	useEditorTimelineScenes,
	useEditorTimelineSelection,
} from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
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
import { requestSmartTakePlan } from "@/ai/smart-takes-plan";
import type { TimelineElement } from "@/timeline/types";

export function SmartTakesControl() {
	const editor = useEditor();
	const scene = useEditorTimelineScenes((e) => e.scenes.getActiveSceneOrNull());
	const selection = useEditorTimelineSelection((e) =>
		e.selection.getSelectedElements(),
	);
	const [stage, setStage] = useState<string | null>(null);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);
	const ids = selection
		.filter(
			(ref) =>
				ref.trackId === scene?.tracks.main.id &&
				scene.tracks.main.elements.some(
					(e) => e.id === ref.elementId && e.type === "video",
				),
		)
		.map((ref) => ref.elementId);
	const disabled =
		!ids.length ||
		!!scene?.takeAssembly ||
		!scene?.tracks.overlay.some((t) => t.type === "text" && t.captionSource);
	const run = async () => {
		if (controller.current || disabled) return;
		const abort = new AbortController();
		controller.current = abort;
		setStage("Preparing transcript");
		try {
			const prepared = editor.command.prepareSmartTakes(ids);
			const plan = await requestSmartTakePlan({
				words: prepared.words,
				signal: abort.signal,
				onStage: setStage,
			});
			abort.signal.throwIfAborted();
			prepared.apply(plan);
			toast.success("Smart takes assembled", {
				description: `${plan.groups.length} story groups. Right-click a take to choose an alternative.`,
				action: { label: "Undo", onClick: () => editor.command.undo() },
			});
		} catch (error) {
			if (!abort.signal.aborted)
				toast.error("Could not assemble takes", {
					description:
						error instanceof Error ? error.message : "Please try again",
				});
		} finally {
			controller.current = null;
			setStage(null);
		}
	};
	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						disabled={disabled || !!stage}
						onClick={() => void run()}
						aria-label="Smart takes — choose the best takes"
					>
						{stage ? (
							<Spinner className="size-3.5" />
						) : (
							<Sparkles className="size-3.5" />
						)}{" "}
						Smart takes
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{scene?.takeAssembly
						? "Right-click an assembled clip to choose a take"
						: "Select transcribed main-track videos. Infer story order, remove filming notes and keep alternative takes."}
				</TooltipContent>
			</Tooltip>
			{stage && (
				<>
					<span
						className="max-w-64 truncate text-xs"
						role="status"
						aria-live="polite"
					>
						{stage}
					</span>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Cancel take analysis"
						onClick={() => controller.current?.abort()}
					>
						<X />
					</Button>
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
				בחר את הטייק הטוב ביותר ({group.alternatives.length})
			</ContextMenuSubTrigger>
			<ContextMenuSubContent className="max-h-96 w-96 overflow-y-auto">
				<div className="px-3 py-2 text-xs text-muted-foreground" dir="auto">
					{group.label} ·{" "}
					{group.confidence < 0.75
						? "Needs review"
						: "Transcript recommendation"}
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
								{assembly.recommendations[ref.groupIndex] === index
									? " · AI pick"
									: ""}
							</span>
							<span className="text-xs text-muted-foreground">
								{duration.toFixed(1)}s · {take.parts.length}{" "}
								{take.parts.length === 1 ? "cut" : "cuts combined"}
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
		<span
			className="pointer-events-none absolute right-1 bottom-1 z-10 flex items-center gap-1 rounded bg-black/75 px-1 text-[10px] text-white"
			title="Right-click to choose a take"
		>
			<Layers className="size-3" />
			{group.alternatives.length}
		</span>
	);
}
