"use client";
import { useEffect } from "react";
import { toast } from "sonner";
import { useEditor, useEditorProject } from "@/editor/use-editor";
import { processMediaAssets } from "@/media/processing";
import { status } from "../client";
import { importDirectorResult } from "../result-import";
/** Observer remains mounted when the user switches asset tabs. */
export function GenerativeResultImporter() {
	const editor = useEditor(),
		projectId = useEditorProject(
			(e) => e.project.getActiveOrNull()?.metadata.id,
		);
	useEffect(() => {
		if (!projectId) return;
		const accountId = window.__opencutAccountId;
		if (!accountId) return;
		let stopped = false;
		const controller = new AbortController();
		const current = () =>
			!stopped &&
			window.__opencutAccountId === accountId &&
			editor.project.getActiveOrNull()?.metadata.id === projectId;
		async function poll() {
			try {
				const state = await status({
					projectId: projectId!,
					signal: controller.signal,
				});
				if (!current()) return;
				for (const job of state.jobs)
					await importDirectorResult({
						editor,
						projectId: projectId!,
						accountId: accountId!,
						job,
						signal: controller.signal,
						current,
						process: processMediaAssets,
						notify: (message) => toast.success(message),
						notifyWarning: (message) => toast.warning(message),
					});
			} catch (e) {
				if (!controller.signal.aborted)
					console.warn(
						"Director result observer:",
						e instanceof Error ? e.message : "Unavailable",
					);
			}
		}
		void poll();
		const timer = setInterval(() => void poll(), 5000);
		return () => {
			stopped = true;
			controller.abort();
			clearInterval(timer);
		};
	}, [editor, projectId]);
	return null;
}
