"use client";

import { MessageSquare } from "lucide-react";
import { useInterfaceLanguage } from "@/i18n/provider";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	useEditor,
	useEditorProject,
	useEditorTimelineScenes,
} from "@/editor/use-editor";
import { DEFAULT_FPS } from "@/fps/defaults";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import { mediaTime, snapSeekMediaTime } from "@/wasm";
import { readClientReview, REVIEW_TICKS_PER_SECOND } from "./canonical";
import { timelineReviewProjection } from "./timeline-projection";

/** Read-only feedback markers. Original render times are never rewritten as bookmarks. */
export function TimelineReviewMarkers({
	zoomLevel,
	dynamicTimelineWidth,
	scrollLeft,
	viewportWidth,
	disabled = false,
}: {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	scrollLeft: number;
	viewportWidth: number;
	disabled?: boolean;
}) {
	const editor = useEditor();
	const { t } = useInterfaceLanguage();
	const project = useEditorProject((e) => e.project.getActiveOrNull());
	const sceneId = useEditorTimelineScenes((e) => e.scenes.getActiveScene().id);
	const duration = useEditorTimelineScenes((e) =>
		e.timeline.getTotalDuration(),
	);
	const { share, comments, outsideTimelineCount } = timelineReviewProjection({
		review: readClientReview(project),
		sceneId,
		durationTicks: duration,
	});
	if (!share || (comments.length === 0 && outsideTimelineCount === 0))
		return null;
	const groups = new Map<number, (typeof comments)[number][]>();
	for (const comment of comments) {
		const x = timelineTimeToPixels({ time: comment.timeTicks, zoomLevel });
		if (
			viewportWidth > 0 &&
			(x < scrollLeft - 32 || x > scrollLeft + viewportWidth + 32)
		)
			continue;
		const group = groups.get(comment.timeTicks) ?? [];
		group.push(comment);
		groups.set(comment.timeTicks, group);
	}
	return (
		<section
			aria-label={t("Latest preview feedback")}
			className="relative h-12 border-b border-violet-400/20 bg-violet-500/5"
			style={{ width: dynamicTimelineWidth }}
		>
			<div
				className="pointer-events-none absolute top-0.5 flex max-w-[min(600px,90vw)] items-center gap-1 truncate px-1 text-[10px] text-muted-foreground"
				style={{ left: scrollLeft }}
			>
				<MessageSquare className="size-3 shrink-0 text-violet-400" />
				<span title={`Preview version ${share.version}`}>
					{t("Preview {version} · Original timestamps", {
						version: share.version.slice(0, 8),
					})}
				</span>
				{outsideTimelineCount > 0 && (
					<span>
						·{" "}
						{t("{count} beyond current edit", { count: outsideTimelineCount })}
					</span>
				)}
			</div>
			{Array.from(groups, ([ticks, grouped]) => {
				const seconds = ticks / REVIEW_TICKS_PER_SECOND;
				const time = `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
				const resolved = grouped.every((comment) => comment.resolved);
				return (
					<Tooltip key={ticks}>
						<TooltipTrigger asChild>
							<button
								type="button"
								disabled={disabled}
								aria-label={`${t("Preview feedback at {time}, {count} comments", { time, count: grouped.length })}${resolved ? ` · ${t("Resolved")}` : ""}`}
								className={`absolute bottom-1 flex h-6 min-w-6 items-center justify-center gap-0.5 rounded-md border px-1 text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 ${resolved ? "border-violet-500/20 bg-background text-muted-foreground" : "border-violet-400/70 bg-violet-500/20 text-violet-300"}`}
								style={{
									left: Math.max(
										0,
										timelineTimeToPixels({ time: ticks, zoomLevel }) - 12,
									),
								}}
								onClick={() =>
									editor.playback.seek({
										time: snapSeekMediaTime({
											time: mediaTime({ ticks }),
											duration,
											fps: project?.settings.fps ?? DEFAULT_FPS,
										}),
									})
								}
							>
								<MessageSquare className="size-3" />
								{grouped.length > 1 && grouped.length}
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-h-80 max-w-sm overflow-y-auto space-y-2"
						>
							<p className="text-xs text-muted-foreground">
								{time} · Preview {share.version} · {t("Original render time")}
							</p>
							{grouped.map((comment) => (
								<div key={comment.id}>
									<p className="text-xs font-medium" dir="auto">
										{comment.authorName}
										{comment.resolved ? ` · ${t("Resolved")}` : ""}
									</p>
									<p
										className="whitespace-pre-wrap break-words text-sm"
										dir="auto"
									>
										{comment.body}
									</p>
								</div>
							))}
						</TooltipContent>
					</Tooltip>
				);
			})}
		</section>
	);
}
