import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import type { ExportOptions, ExportPlan } from "@/export";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { SerializedProject } from "@/services/storage/types";

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
export async function planSavedExport({
	projectId,
	project,
	mediaAssets,
	sceneId,
	options,
	storageRevision,
	editorRevision,
}: {
	projectId: string;
	project: SerializedProject;
	mediaAssets: CanonicalClassicSnapshot["mediaAssets"];
	sceneId?: string;
	options?: ExportOptions;
	storageRevision: number;
	editorRevision?: number;
}) {
	const runtime = await loadCanonicalRuntime();
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
			storageRevision: storageRevision,
			sourceRevision: editorRevision ?? state.revision,
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
