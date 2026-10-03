"use client";
import { useState } from "react";
import {
	useEditor,
	useEditorMedia,
	useEditorProject,
} from "@/editor/use-editor";

export function OfflineMediaPanel() {
	const editor = useEditor();
	const assets = useEditorMedia((e) => e.media.getAssets());
	const projectId = useEditorProject((e) => e.project.getActive()?.metadata.id);
	const [open, setOpen] = useState(false);
	const [paths, setPaths] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const missing = assets.filter((asset) => asset.missing);
	const relevant = assets.filter(
		(asset) => asset.missing || asset.canUndoRelink,
	);
	if (!relevant.length || !projectId) return null;
	async function link(id: string, source: string, undo = false) {
		setBusy(true);
		setError("");
		try {
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
				{missing.length
					? `${missing.length} source file(s) offline — Link missing files`
					: "Media links — undo relink"}
			</button>
			{open && (
				<div className="max-h-64 space-y-3 overflow-auto pt-2">
					<p>
						All cuts, effects and timing are retained. You can keep editing.
						Paste the full path to the original file on this computer to restore
						playback and export.
					</p>
					{relevant.map((asset) => (
						<div key={asset.id} className="space-y-1">
							<div className="font-medium">
								{asset.name} {asset.missing ? "(Media offline)" : "(Linked)"}
							</div>
							<div className="break-all text-muted-foreground">
								{asset.sourcePath || asset.fileName}
							</div>
							{asset.missing && (
								<div className="flex gap-2">
									<input
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
										onClick={() => void link(asset.id, paths[asset.id].trim())}
									>
										Link file
									</button>
								</div>
							)}
							{asset.canUndoRelink && (
								<button
									className="underline"
									disabled={busy}
									onClick={() => void link(asset.id, "", true)}
								>
									Undo last relink
								</button>
							)}
						</div>
					))}
					{error && (
						<p role="alert" className="text-red-500">
							{error}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
