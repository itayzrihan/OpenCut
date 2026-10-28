/** Authenticated saved-project IO. Canonical capture/plan owns export policy. */
import { operateEditorSession } from "@/editor-agent/server/session-store";
import { listMedia } from "@/services/local-drive/server";
import type { ExportOptions, ExportPlan } from "@/export";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { SerializedProject } from "@/services/storage/types";
import { enqueueRender } from "./queue/server";
export type SavedExportInfo = {
	projectId: string;
	name: string;
	storageRevision: number;
	sourceRevision: number;
	sceneId: string;
	scenes: { id: string; name: string; isMain: boolean }[];
	options: Required<ExportOptions>;
	plan: ExportPlan;
};
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
	const { CanonicalEditorRuntime } =
		await import("opencut-editor-runtime-wasm");
	const runtime = new CanonicalEditorRuntime();
	try {
		runtime.invokeSync(
			"project.classic.session.attach",
			{
				projectId,
				expectedRevision: 0,
				classic: { document: project, mediaAssets },
			},
			undefined,
		);
		const state = runtime.snapshot() as {
			revision: number;
			project: { classic: CanonicalClassicSnapshot };
		};
		const doc = state.project.classic.document;
		const selected = sceneId ?? doc.currentSceneId;
		const scene = doc.scenes.find((s) => s.id === selected);
		if (!scene) throw Error("Choose a saved scene to export");
		const settings = scene.settings ?? doc.settings;
		const recipe: Required<ExportOptions> = {
			format: options?.format ?? "mp4",
			quality: options?.quality ?? "very_high",
			preferences: options?.preferences ??
				settings.exportPreferences ?? {
					resolution: "source",
					encoding: "compact",
				},
			fps: options?.fps ?? settings.fps,
			includeAudio: options?.includeAudio ?? true,
		};
		const invoke = <T>(capability: string, input: unknown) =>
			(
				runtime.invokeSync(capability, input, undefined) as {
					result: { data: T };
				}
			).result.data;
		const captured = invoke<{ snapshot: CanonicalClassicSnapshot }>(
			"project.classic.export.capture",
			{ projectId, expectedRevision: state.revision, sceneId: selected },
		);
		const plan = invoke<ExportPlan>("project.classic.export.plan", {
			projectId,
			expectedRevision: state.revision,
			sceneId: selected,
			preferences: recipe.preferences,
			quality: recipe.quality,
			format: recipe.format,
			fps: recipe.fps,
		});
		const info: SavedExportInfo = {
			projectId,
			name: doc.metadata.name,
			storageRevision: view.storageRevision,
			sourceRevision: view.saved?.editorRevision ?? state.revision,
			sceneId: selected,
			scenes: doc.scenes.map(({ id, name, isMain }) => ({ id, name, isMain })),
			options: recipe,
			plan,
		};
		return { info, snapshot: captured.snapshot };
	} finally {
		runtime.free();
	}
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
