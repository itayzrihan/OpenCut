import { accountAssetUrl } from "@/accounts/browser";
import type { EditorCore } from "@/core";
import type { ExportOptions } from "@/export";
import type { RenderQueueView } from "./types";
export async function renderQueueRequest<T = RenderQueueView>(
	body?: unknown,
): Promise<T> {
	const response = await fetch(
		accountAssetUrl("/api/render-queue"),
		body
			? {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}
			: { cache: "no-store" },
	);
	const result = await response.json();
	if (!response.ok) throw Error(result.error ?? "Render queue request failed");
	return result;
}
/** A separate browsing realm owns the compositor, audio scratch and GPU caches. */
export function openRenderQueue() {
	// No opener means a separate browsing context group: the encoder must not
	// share the editor's synchronous JavaScript event loop or project singleton.
	window.open(
		accountAssetUrl("/render-queue"),
		"_blank",
		"noopener,popup,width=1050,height=720",
	);
}

export async function enqueueCurrentRender({
	editor,
	options,
	id = crypto.randomUUID(),
}: {
	editor: EditorCore;
	options: ExportOptions;
	id?: string;
}) {
	const project = editor.project.getActive();
	const sceneId = editor.scenes.getActiveScene().id;
	// Synchronous canonical capture happens before the first await.
	const captured = editor.command.captureExportSnapshot(sceneId);
	return renderQueueRequest({
		action: "enqueue",
		id,
		projectId: project.metadata.id,
		sceneId,
		...captured,
		options: {
			...options,
			fps: options.fps ?? project.settings.fps,
			includeAudio: options.includeAudio ?? true,
		},
	});
}
