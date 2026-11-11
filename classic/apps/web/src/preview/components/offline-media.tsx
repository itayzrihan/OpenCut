"use client";
import { LocalizedValue as UiValue } from "@/i18n/message";
import {
	Message as UiMessage,
	LocalizedElement as UiLocalized,
} from "@/i18n/message";
import { useState } from "react";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { ProjectMediaPullPanel } from "@/peer-sync/project-panel";
import {
	useEditor,
	useEditorMedia,
	useEditorProject,
} from "@/editor/use-editor";

export function OfflineMediaPanel() {
	const editor = useEditor();
	const assets = useEditorMedia((e) => e.media.getAssets());
	const projectId = useEditorProject(
		(e) => e.project.getActiveForScene()?.metadata.id,
	);
	const [open, setOpen] = useState(false);
	const [paths, setPaths] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const hosted = isHostedBrowserWorkspace();
	const missing = assets.filter((asset) => asset.missing);
	const relevant = assets.filter(
		(asset) => asset.missing || asset.canUndoRelink,
	);
	if (!relevant.length || !projectId) return null;
	async function link({
		id,
		source = "",
		file,
		undo = false,
	}: {
		id: string;
		source?: string;
		file?: File;
		undo?: boolean;
	}) {
		setBusy(true);
		setError("");
		try {
			if (hosted && !undo)
				await editor.media.reopenBrowserSource({
					projectId: projectId!,
					id,
					file,
				});
			else
				await editor.media.relink({ projectId: projectId!, id, source, undo });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="z-20 shrink-0 border-b border-amber-500/40 bg-background p-2 text-xs">
			<button
				className="text-amber-500 underline"
				onClick={() => setOpen(!open)}
				aria-expanded={open}
			>
				{missing.length ? (
					<UiMessage
						text={"{v0} source file(s) offline — Link missing files"}
						values={{ v0: String(missing.length) }}
					/>
				) : (
					<UiMessage text={"Media links — undo relink"} />
				)}
			</button>
			{open && (
				<div className="max-h-64 space-y-3 overflow-auto pt-2">
					{!!missing.length && (
						<ProjectMediaPullPanel
							key={projectId}
							editor={editor}
							projectId={projectId}
						/>
					)}
					{!hosted && (
						<p>
							<UiMessage
								text={
									"All cuts, effects and timing are retained. You can keep editing. Paste the full path to the original file on this computer to restore playback and export."
								}
							/>
						</p>
					)}
					{relevant.map((asset) => (
						<div key={asset.id} className="space-y-1">
							<div className="font-medium">
								{asset.name}{" "}
								{asset.missing ? (
									<UiMessage text={"(Media offline)"} />
								) : (
									<UiMessage text={"(Linked)"} />
								)}
							</div>
							<div className="break-all text-muted-foreground">
								{asset.sourcePath || asset.fileName}
							</div>
							{asset.missing && hosted && (
								<div className="flex flex-wrap gap-3">
									{asset.storageKind === "linked" && !asset.sourcePath && (
										<button
											className="underline"
											disabled={busy}
											onClick={() => void link({ id: asset.id })}
										>
											<UiMessage text="Reconnect original file" />
										</button>
									)}
									<label className="cursor-pointer underline focus-within:outline">
										<UiMessage text="Choose file" />
										<input
											type="file"
											className="sr-only"
											disabled={busy}
											onChange={(event) => {
												const file = event.currentTarget.files?.[0];
												event.currentTarget.value = "";
												if (file) void link({ id: asset.id, file });
											}}
										/>
									</label>
								</div>
							)}
							{asset.missing && !hosted && (
								<div className="flex gap-2">
									<UiLocalized<"input">
										element={"input"}
										messageProps={["placeholder"]}
										aria-label={`Source path for ${asset.name}`}
										className="min-w-0 flex-1 rounded border bg-background p-1"
										value={paths[asset.id] ?? ""}
										placeholder="C:\Media\original.mp4"
										onChange={(e) =>
											setPaths({ ...paths, [asset.id]: e.target.value })
										}
									/>
									<button
										disabled={busy || !paths[asset.id]?.trim()}
										onClick={() =>
											void link({
												id: asset.id,
												source: paths[asset.id].trim(),
											})
										}
									>
										<UiMessage text={"Link file"} />
									</button>
								</div>
							)}
							{asset.canUndoRelink && (
								<button
									className="underline"
									disabled={busy}
									onClick={() =>
										void link({ id: asset.id, source: "", undo: true })
									}
								>
									<UiMessage text={"Undo last relink"} />
								</button>
							)}
						</div>
					))}
					{error && (
						<p role="alert" className="text-red-500">
							<UiValue>{error}</UiValue>
						</p>
					)}
				</div>
			)}
		</div>
	);
}
