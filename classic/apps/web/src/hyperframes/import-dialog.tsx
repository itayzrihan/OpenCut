"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import { mediaTimeToSeconds } from "@/wasm";
import { storageService } from "@/services/storage/service";
import { prepareRecoveredFolder } from "./import-recovery";
import type {
	HyperframesImportRecovery,
	HyperframesImportRecoverySummary,
} from "./import-recovery-types";
import {
	planHyperframesFolder,
	readHyperframesFolder,
	type HyperframesFolder,
} from "./folder";
import {
	importHyperframesFolder,
	type HyperframesImportProgress,
} from "./import-folder";

const PHASE_LABELS: Record<HyperframesImportProgress["phase"], string> = {
	checking: "Checking the composition…",
	uploading: "Copying project files…",
	loading: "Loading the animation…",
	committing: "Adding to the timeline…",
	saving: "Saving the project…",
};

/** Selection and progress only; Rust owns package rules and the timeline edit. */
export function HyperframesImportDialog({ onClose }: { onClose: () => void }) {
	const editor = useEditor();
	const id = useId();
	const picker = useRef<HTMLInputElement>(null);
	const operation = useRef<AbortController | null>(null);
	const [folder, setFolder] = useState<HyperframesFolder | null>(null);
	const [entryFile, setEntryFile] = useState("");
	const [placement, setPlacement] = useState("playhead");
	const [busy, setBusy] = useState(false);
	const [canceling, setCanceling] = useState(false);
	const [progress, setProgress] = useState<HyperframesImportProgress | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState<HyperframesImportRecoverySummary[]>(
		[],
	);
	const [recovery, setRecovery] = useState<HyperframesImportRecovery | null>(
		null,
	);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	useEffect(() => () => operation.current?.abort(), []);
	useEffect(() => {
		if (busy) return;
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		const accountId = window.__opencutAccountId;
		if (!projectId || !accountId) return;
		const controller = new AbortController();
		void storageService
			.listMediaUploads({
				projectId,
				scope: { accountId, signal: controller.signal },
			})
			.then(
				(items) => {
					if (!controller.signal.aborted) {
						setPending(items);
						setRecoveryError(null);
					}
				},
				(cause: unknown) => {
					if (!controller.signal.aborted)
						setRecoveryError(
							cause instanceof Error ? cause.message : String(cause),
						);
				},
			);
		return () => controller.abort();
	}, [editor, busy]);
	const chooseRecovery = async (uploadToken: string) => {
		if (operation.current) return;
		const projectId = editor.project.getActiveOrNull()?.metadata.id;
		const accountId = window.__opencutAccountId;
		if (!projectId || !accountId) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setError(null);
		setFolder(null);
		try {
			const saved = await storageService.readMediaUpload({
				projectId,
				uploadToken,
				scope: { accountId, signal: controller.signal },
			});
			controller.signal.throwIfAborted();
			setRecovery(saved);
			setEntryFile(saved.draft.source.entryFile);
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			operation.current = null;
			setBusy(false);
			setCanceling(false);
			if (controller.signal.aborted) onClose();
		}
	};

	const chooseFolder = async (files: File[]) => {
		if (!files.length || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		setBusy(true);
		setFolder(null);
		setError(null);
		try {
			const runtime = await loadCanonicalRuntime();
			try {
				controller.signal.throwIfAborted();
				const selected = planHyperframesFolder({ files, runtime });
				setFolder(selected);
				setEntryFile(selected.plan.entryFile ?? "");
			} finally {
				runtime.free();
			}
		} catch (cause) {
			if (!controller.signal.aborted)
				setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			operation.current = null;
			setBusy(false);
			setCanceling(false);
			if (controller.signal.aborted) onClose();
		}
	};

	const importFolder = async () => {
		if ((!folder && !recovery) || !entryFile || operation.current) return;
		const controller = new AbortController();
		operation.current = controller;
		const projectId = editor.project.getActive().metadata.id;
		const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
		const accountId = window.__opencutAccountId;
		const startSeconds =
			placement === "end"
				? undefined
				: placement === "start"
					? 0
					: mediaTimeToSeconds({ time: editor.playback.getCurrentTime() });
		setBusy(true);
		setError(null);
		setProgress({ phase: "checking", completed: 0, total: 0 });
		try {
			const prepared = await (async () => {
				if (recovery)
					return prepareRecoveredFolder({
						recovery,
						selected: folder,
						signal: controller.signal,
					});
				if (!folder) throw new Error("Choose the project folder");
				const runtime = await loadCanonicalRuntime();
				try {
					controller.signal.throwIfAborted();
					const selected = planHyperframesFolder({
						files: [...folder.files.values()],
						runtime,
						entryFile,
					});
					return await readHyperframesFolder({
						folder: selected,
						runtime,
						signal: controller.signal,
					});
				} finally {
					runtime.free();
				}
			})();
			controller.signal.throwIfAborted();
			if (
				editor.project.getActiveOrNull()?.metadata.id !== projectId ||
				editor.scenes.getActiveSceneOrNull()?.id !== sceneId ||
				window.__opencutAccountId !== accountId
			)
				throw new Error(
					"The active project changed while reading the folder. Open the import again.",
				);
			const result = await importHyperframesFolder({
				editor,
				folder: prepared,
				startSeconds,
				signal: controller.signal,
				onProgress: setProgress,
				recovery: recovery ?? undefined,
			});
			if (
				editor.project.getActiveOrNull()?.metadata.id === projectId &&
				editor.scenes.getActiveSceneOrNull()?.id === sceneId &&
				result.itemId &&
				result.trackId
			) {
				const [imported] = editor.timeline.getElementsWithTracks({
					elements: [{ trackId: result.trackId, elementId: result.itemId }],
				});
				if (imported)
					editor.playback.seek({ time: imported.element.startTime });
			}
			if (result.saveError) {
				toast.warning("Composition added; project save needs attention", {
					description: result.saveError,
				});
			} else {
				toast.success(
					recovery
						? "Import recovered and saved"
						: `${prepared.name} added to the timeline`,
				);
			}
			onClose();
		} catch (cause) {
			// Cleanup failures must remain visible even after the user cancels.
			if (!controller.signal.aborted || cause instanceof AggregateError)
				setError(cause instanceof Error ? cause.message : String(cause));
			else onClose();
		} finally {
			operation.current = null;
			setBusy(false);
			setCanceling(false);
			setProgress(null);
		}
	};
	const finishing =
		progress?.phase === "committing" || progress?.phase === "saving";
	const close = () => {
		if (finishing) return;
		if (operation.current) {
			setCanceling(true);
			operation.current.abort();
		} else onClose();
	};
	const selectClass =
		"h-9 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-50";
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Import HyperFrames</DialogTitle>
					<DialogDescription>
						Add a composition as a clip alongside your footage. Choose its
						project folder, including images, fonts and scripts.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{!recovery && pending.length > 0 && (
						<section className="space-y-2" aria-label="Interrupted imports">
							<p className="text-sm font-medium">
								Continue an interrupted import
							</p>
							{pending.map((item) => {
								const scene = editor.scenes
									.getScenes()
									.find((scene) => scene.id === item.sceneId);
								const wrongScene =
									item.sceneId !== editor.scenes.getActiveSceneOrNull()?.id;
								return (
									<div
										key={item.uploadToken}
										className="flex items-center gap-3 rounded-md border p-3"
									>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm">{item.name}</p>
											<p className="text-xs text-muted-foreground">
												{item.completed}/{item.total} files copied
												{wrongScene
													? ` · Open ${scene?.name ?? "the original scene"}`
													: ""}
											</p>
										</div>
										<Button
											variant="outline"
											disabled={busy || wrongScene}
											aria-label={`Continue ${item.name}`}
											onClick={() => void chooseRecovery(item.uploadToken)}
										>
											Continue
										</Button>
									</div>
								);
							})}
						</section>
					)}
					{recovery && (
						<div className="space-y-2 rounded-md border p-3">
							<p className="text-sm font-medium">
								Continue {recovery.draft.name}
							</p>
							<p className="text-xs text-muted-foreground">
								{recovery.readyAssetIds.length}/
								{recovery.draft.resources.length} files already copied.{" "}
								{recovery.readyAssetIds.length < recovery.draft.resources.length
									? "Choose the original folder to copy the remaining files."
									: "The saved files are ready. Continue to finish the import."}
							</p>
							<Button
								variant="ghost"
								disabled={busy}
								onClick={() => {
									setRecovery(null);
									setFolder(null);
									setEntryFile("");
									setError(null);
								}}
							>
								Start a different import
							</Button>
						</div>
					)}
					{recoveryError && (
						<p className="text-xs text-destructive">
							Could not check interrupted imports: {recoveryError}
						</p>
					)}
					<input
						ref={(node) => {
							picker.current = node;
							node?.setAttribute("webkitdirectory", "");
						}}
						type="file"
						multiple
						className="hidden"
						aria-label="HyperFrames project folder"
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							event.target.value = "";
							void chooseFolder(files);
						}}
					/>
					<Button
						variant="outline"
						className="h-auto min-h-16 justify-start whitespace-normal p-4 text-left"
						disabled={busy}
						onClick={() => picker.current?.click()}
					>
						<FolderOpen />
						<span className="min-w-0">
							<span className="block break-all">
								{folder?.name ?? "Choose project folder"}
							</span>
							{folder && (
								<span className="mt-1 block text-xs font-normal text-muted-foreground">
									{folder.plan.files.length} files ·{" "}
									{folder.plan.resourceBytes < 1024 * 1024
										? `${Math.ceil(folder.plan.resourceBytes / 1024)} KB`
										: `${(folder.plan.resourceBytes / 1024 / 1024).toFixed(1)} MB`}{" "}
									of media
								</span>
							)}
						</span>
					</Button>
					{folder && !recovery && (
						<>
							<div className="space-y-2">
								<label htmlFor={`${id}-entry`} className="text-sm font-medium">
									Entry file
								</label>
								<select
									id={`${id}-entry`}
									className={selectClass}
									value={entryFile}
									disabled={busy}
									onChange={(event) => setEntryFile(event.target.value)}
								>
									<option value="" disabled>
										Choose the main HTML file
									</option>
									{folder.plan.entryCandidates.map((path) => (
										<option key={path} value={path}>
											{path}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-2">
								<label
									htmlFor={`${id}-placement`}
									className="text-sm font-medium"
								>
									Add to timeline
								</label>
								<select
									id={`${id}-placement`}
									className={selectClass}
									value={placement}
									disabled={busy}
									onChange={(event) => setPlacement(event.target.value)}
								>
									<option value="playhead">
										At playhead · above existing clips
									</option>
									<option value="end">After existing clips</option>
									<option value="start">From the beginning</option>
								</select>
							</div>
							<p className="text-xs text-muted-foreground">
								Imported files are copied into this project. Embedded audio
								follows the composition during playback and export.
							</p>
						</>
					)}
					{busy && (
						<div role="status" className="flex items-center gap-2 text-sm">
							<Loader2 className="size-4 animate-spin" />
							{canceling
								? recovery
									? "Stopping the import…"
									: "Canceling and removing uploaded files…"
								: progress
									? PHASE_LABELS[progress.phase]
									: "Reading the folder…"}
							{!canceling && progress?.phase === "uploading" && (
								<span className="ml-auto tabular-nums">
									{progress.completed}/{progress.total}
								</span>
							)}
						</div>
					)}
					{error && (
						<p
							role="alert"
							className="max-h-32 overflow-auto break-words text-sm text-destructive"
						>
							{error}
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={finishing || canceling}
						onClick={close}
					>
						Cancel
					</Button>
					<Button
						disabled={
							busy ||
							!entryFile ||
							(!folder &&
								(!recovery ||
									recovery.readyAssetIds.length <
										recovery.draft.resources.length))
						}
						onClick={() => void importFolder()}
					>
						{recovery ? "Continue import" : "Add composition"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
