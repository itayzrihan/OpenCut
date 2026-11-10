import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useEditor, useEditorMedia } from "@/editor/use-editor";
import { useInterfaceLanguage } from "@/i18n/provider";
import { SeamlessConnectDialog } from "./seamless-connect-control";
import {
	getSeamlessSelection,
	type SeamlessSelection,
} from "../seamless-connect";
import type { ChapterPlan, DirectorDocument } from "../types";

/** A canonical collection references real Media assets; preview never renders on the server. */
export function ChapterCollectionCard({
	plan,
	document,
	insert,
}: {
	plan: ChapterPlan;
	document: DirectorDocument;
	insert: () => { trackId: string; elementId: string }[] | null;
}) {
	const editor = useEditor();
	const assets = useEditorMedia((e) => e.media.getAssets());
	const { t } = useInterfaceLanguage();
	const [index, setIndex] = useState(0);
	const [preview, setPreview] = useState(false);
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const [selection, setSelection] = useState<SeamlessSelection | null>(null);
	const video = useRef<HTMLVideoElement>(null);
	const advancing = useRef(false);
	const [account] = useState(() => window.__opencutAccountId);
	const mediaIds = plan.jobIds.map(
		(id) => document.jobs.find((j) => j.id === id)?.mediaId,
	);
	const asset = assets.find((a) => a.id === mediaIds[index]);
	const file = asset?.file;
	const storedUrl = asset?.url;
	const duration = Math.min(
		asset?.duration ?? 0,
		plan.chapters[index]?.duration ?? 0,
	);
	useEffect(() => {
		let owned: string | undefined;
		const next = file ? (owned = URL.createObjectURL(file)) : (storedUrl ?? "");
		queueMicrotask(() => {
			setUrl(next);
			advancing.current = false;
		});
		return () => {
			if (owned) URL.revokeObjectURL(owned);
		};
	}, [file, storedUrl, index]);
	function next() {
		if (advancing.current) return;
		advancing.current = true;
		if (index + 1 < plan.chapters.length) setIndex(index + 1);
		else {
			video.current?.pause();
			setPreview(false);
			setIndex(0);
		}
	}
	function connect() {
		try {
			const current = editor.scenes.getActiveSceneOrNull();
			if (!current) throw new Error("Open a scene first");
			let pairs: SeamlessSelection | null = null;
			for (const track of [current.tracks.main, ...current.tracks.overlay]) {
				if (track.type !== "video") continue;
				const ordered = [...track.elements].sort(
					(a, b) => a.startTime - b.startTime,
				);
				for (let start = 0; start < ordered.length; start++) {
					const selected = ordered.slice(start, start + mediaIds.length);
					if (
						selected.length === mediaIds.length &&
						selected.every(
							(clip, i) =>
								clip.type === "video" && clip.mediaId === mediaIds[i],
						)
					) {
						pairs = getSeamlessSelection(
							selected.map((element) => ({ track, element })),
						);
						break;
					}
				}
				if (pairs) break;
			}
			if (!pairs) {
				const inserted = insert();
				if (!inserted) return;
				pairs = getSeamlessSelection(
					editor.timeline.getElementsWithTracks({ elements: inserted }),
				);
			}
			if (!pairs)
				throw new Error("The collection needs at least two video clips");
			setSelection(pairs);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}
	if (account !== window.__opencutAccountId) return null;
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<article
						className="space-y-2 rounded-lg border bg-background p-3"
						aria-label={plan.title}
					>
						<div className="flex justify-between gap-2">
							<strong className="truncate">{plan.title}</strong>
							<span className="text-xs tabular-nums">
								{plan.chapters.length} ·{" "}
								{plan.chapters.reduce(
									(total, chapter) => total + chapter.duration,
									0,
								)}
								s
							</span>
						</div>
						<p className="text-xs text-muted-foreground">
							{t("Combined collection · editable cuts")}
						</p>
						{preview && url ? (
							<video
								ref={video}
								src={url}
								controls
								autoPlay
								className="max-h-52 w-full rounded"
								onEnded={next}
								onTimeUpdate={() => {
									if (
										video.current &&
										duration > 0 &&
										video.current.currentTime >= duration
									)
										next();
								}}
								onError={() =>
									setError(t("The local chapter video is unavailable."))
								}
							>
								<track
									kind="captions"
									label={t("Captions not supplied")}
									srcLang="und"
								/>
							</video>
						) : null}
						{preview && !url && (
							<p className="text-xs">
								{t("The local chapter video is unavailable.")}
							</p>
						)}
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setPreview(!preview);
									setIndex(0);
									advancing.current = false;
								}}
							>
								{t(preview ? "Close preview" : "Preview collection")}
							</Button>
							<Button size="sm" variant="outline" onClick={() => insert()}>
								{t("Insert clips")}
							</Button>
							{plan.chapters.length > 1 && (
								<Button size="sm" variant="outline" onClick={connect}>
									Seamless Connect
								</Button>
							)}
						</div>
						{preview && (
							<p className="text-xs">
								{plan.chapters[index].title} · {index + 1}/
								{plan.chapters.length}
							</p>
						)}
						{error && (
							<p role="alert" className="text-xs text-destructive">
								{error}
							</p>
						)}
					</article>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem
						onSelect={() => {
							setPreview(true);
							setIndex(0);
						}}
					>
						{t("Preview collection")}
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => insert()}>
						{t("Insert clips")}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={plan.chapters.length < 2}
						onSelect={connect}
					>
						Seamless Connect
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{selection && (
				<SeamlessConnectDialog
					{...selection}
					open
					onOpenChange={(open) => {
						if (!open) setSelection(null);
					}}
				/>
			)}
		</>
	);
}
