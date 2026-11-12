import { accountAssetUrl, isHostedBrowserWorkspace } from "@/accounts/browser";
import type { EditorCore } from "@/core";
import type { ExportOptions } from "@/export";
import type { RenderQueueView } from "./types";
export async function renderQueueRequest<T = RenderQueueView>(
	body?: unknown,
): Promise<T> {
	if (isHostedBrowserWorkspace()) {
		const { browserRenderRequest } = await import("./browser");
		return (await browserRenderRequest(body)) as T;
	}
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
	if (!response.ok)
		throw Object.assign(Error(result.error ?? "Render queue request failed"), {
			status: response.status,
		});
	return result;
}
/** The shared queue is a view, never the owner of a render process. */
export function openRenderQueue() {
	window.dispatchEvent(new Event("opencut:open-render-queue"));
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

/** Open an isolated browser tab only from the Start button's user gesture. */
export async function startQueuedRenders() {
	const account = window.__opencutAccountId;
	const hosted = isHostedBrowserWorkspace();
	let popup: Window | null = null;
	if (hosted) {
		if (!account || !navigator.locks)
			throw Error("Open the export queue in a supported browser");
		popup = window.open(
			`/render-worker?hosted=1&account=${encodeURIComponent(account)}`,
			"_blank",
		);
		if (!popup)
			throw Error(
				"Allow POCUT to open a render tab, then start the queue again",
			);
		popup.opener = null;
	}
	try {
		return await renderQueueRequest({ action: "start" });
	} catch (error) {
		popup?.close();
		throw error;
	}
}
