"use client";

import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditor, useEditorSelection } from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import { toast } from "@/i18n/toast";
import { useTimelineStore } from "@/timeline/timeline-store";
import type { TimelineTrack } from "@/timeline/types";
import { cn } from "@/utils/ui";

export function TrackSelectButton({ track }: { track: TimelineTrack }) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const rangeLocked = useTimelineStore(
		(state) => state.aiRangeSelection.isTimelineLocked,
	);
	const selected = useEditorSelection((current) => {
		const elements = current.selection.getSelectedElements();
		return (
			current.selection.getExactTrackSelectionId() === track.id &&
			track.elements.length > 0 &&
			current.selection.getActiveSelectionKind() === "elements" &&
			elements.length === track.elements.length
		);
	});
	const label = t("Select all clips in {track}", { track: track.name });
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={cn(
				"size-4",
				selected ? "text-primary" : "text-muted-foreground",
			)}
			aria-label={label}
			title={label}
			aria-pressed={selected}
			disabled={
				!track.elements.length ||
				("locked" in track && track.locked === true) ||
				rangeLocked
			}
			onPointerDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				try {
					editor.command.selectClassicTrack({
						trackId: track.id,
						additive: event.shiftKey || event.ctrlKey || event.metaKey,
					});
				} catch (error) {
					toast.error(
						error instanceof Error ? error.message : "Track selection failed",
					);
				}
			}}
		>
			<ListChecks className="size-4" />
		</Button>
	);
}
