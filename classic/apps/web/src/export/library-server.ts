/** Authenticated saved-project IO. Canonical capture/plan owns export policy. */
import { operateEditorSession } from "@/editor-agent/server/session-store";
import { listMedia } from "@/services/local-drive/server";
import type { ExportOptions } from "@/export";
import type { SerializedProject } from "@/services/storage/types";
import { enqueueRender } from "./queue/server";
import { planSavedExport } from "./library-snapshot";
export type { SavedExportInfo } from "./library-snapshot";
export async function captureSavedExport({
	projectId,
	sceneId,
	options,
	expectedStorageRevision,
}: {
	projectId: string;
	sceneId?: string;
	options?: ExportOptions;
	expectedStorageRevision?: number;
}) {
	const view = (await operateEditorSession({
		projectId,
		request: { type: "read" },
	})) as unknown as {
		storageRevision: number;
		saved: { project: SerializedProject; editorRevision: number } | null;
		legacyProject: SerializedProject | null;
	};
	if (
		expectedStorageRevision !== undefined &&
		view.storageRevision !== expectedStorageRevision
	)
		throw Error(
			"This project has changed since opening Export. Reopen the dialog to use its latest saved version.",
		);
	const project = view.saved?.project ?? view.legacyProject;
	if (!project) throw Error("Saved project is unavailable");
	const records = await listMedia(projectId);
	const mediaAssets = records.map((record) => {
		const {
			url: _url,
			thumbnailUrl: _thumbnail,
			file: _file,
			...binding
		} = record as typeof record & { url?: string; file?: unknown };
		return binding;
	});
	return planSavedExport({
		projectId,
		project,
		mediaAssets,
		sceneId,
		options,
		storageRevision: view.storageRevision,
		editorRevision: view.saved?.editorRevision,
	});
}

export async function enqueueSavedExport(input: {
	id: string;
	projectId: string;
	sceneId: string;
	expectedStorageRevision: number;
	options: ExportOptions;
	delivery: "queue" | "direct";
	destinationName?: string;
}) {
	const { readRenderQueue } = await import("./queue/server");
	const existing = (await readRenderQueue()).jobs.find(
		(j) => j.id === input.id,
	);
	if (existing) {
		if (
			existing.projectId !== input.projectId ||
			existing.delivery !== input.delivery ||
			(input.delivery === "direct" &&
				existing.destinationName !== input.destinationName)
		)
			throw Error("Export identity conflict");
		return existing;
	}
	const { info, snapshot } = await captureSavedExport(input);
	const state = await enqueueRender({
		...input,
		sourceRevision: info.sourceRevision,
		snapshot,
		options: info.options,
	});
	return state.jobs.find((j) => j.id === input.id)!;
}
