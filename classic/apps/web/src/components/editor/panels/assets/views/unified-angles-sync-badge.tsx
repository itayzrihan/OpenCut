"use client";
import { LoaderCircle } from "lucide-react";
import type { MediaAsset } from "@/media/types";
import { unifiedAnglesSyncStatus } from "@/media/unified-angles";
import {
	useEditor,
	useEditorMedia,
	useEditorProject,
} from "@/editor/use-editor";

export function UnifiedAnglesSyncBadge({ item }: { item: MediaAsset }) {
	const editor = useEditor();
	const media = useEditorMedia((e) => e.media.getAssets());
	const project = useEditorProject((e) => e.project.getActiveOrNull());
	const status = unifiedAnglesSyncStatus({
		asset: item,
		mediaMap: new Map(media.map((a) => [a.id, a])),
	});
	const task = item.unifiedAngles?.syncTask;
	const running =
		task?.status === "running" && editor.media.isUnifiedAnglesSyncing(item.id);
	const readOnly = editor.project.getSessionReadOnlyReason();
	if (status === "synced")
		return (
			<span
				className="block text-[11px] font-medium text-emerald-500"
				title="Camera angles are synchronized by audio"
			>
				Audio synced
			</span>
		);
	const interrupted =
		task?.status === "cancelled" || (task?.status === "running" && !running);
	const failed = task?.status === "failed";
	const label = running
		? "Syncing audio"
		: interrupted
			? "Sync interrupted · Retry"
			: failed
				? "Sync failed · Retry"
				: status === "stale"
					? "Sync outdated · Retry"
					: "Not audio synced";
	const hint =
		readOnly ??
		(running
			? task?.stage
			: (task?.error ??
				"Click to synchronize the selected camera angles by their recorded audio"));
	return (
		<button
			type="button"
			disabled={running || !!readOnly || !project}
			aria-busy={running}
			aria-label={`${running ? "Syncing audio" : interrupted || failed || status === "stale" ? "Retry audio sync" : "Sync audio"} for ${item.name}`}
			title={hint}
			className="block max-w-full text-left text-[11px] font-medium text-amber-500 hover:underline disabled:cursor-default disabled:no-underline"
			onPointerDown={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onClick={(e) => {
				e.stopPropagation();
				if (project)
					void editor.media.syncUnifiedAngles({
						projectId: project.metadata.id,
						mediaId: item.id,
					});
			}}
		>
			<span className="flex items-center gap-1">
				{running && (
					<LoaderCircle
						className="size-3 shrink-0 animate-spin"
						aria-hidden="true"
					/>
				)}
				<span className="truncate">
					{label}
					{running ? ` ${Math.round((task?.progress ?? 0) * 100)}%` : ""}
				</span>
			</span>
			{running && (
				<span
					role="progressbar"
					aria-label="Audio synchronization progress"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round((task?.progress ?? 0) * 100)}
					className="mt-0.5 block h-0.5 w-full overflow-hidden rounded bg-amber-500/20"
				>
					<span
						className="block h-full bg-amber-500"
						style={{ width: `${(task?.progress ?? 0) * 100}%` }}
					/>
				</span>
			)}
		</button>
	);
}
