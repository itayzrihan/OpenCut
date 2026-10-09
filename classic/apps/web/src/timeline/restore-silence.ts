/** Classic source adapter. Timing and selection validation belong to Rust. */
import { restoreSilence } from "opencut-wasm";
import type { EditorCore } from "@/core";
import {
	buildTimelineDocumentV2,
	parseTimelineDocumentV2,
} from "@/ai/timeline-document-v2";
import { updateSceneInArray } from "@/timeline/scenes";

type Selection = { trackId: string; elementId: string }[];

export function previewRestoreSilence({
	editor,
	selection,
}: {
	editor: EditorCore;
	selection: Selection;
}) {
	if (
		selection.length < 2 ||
		selection.some((item) => item.trackId !== selection[0].trackId)
	)
		return null;
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const source = buildTimelineDocumentV2({ project, scene });
	if (!source.valid) return null;
	const result = restoreSilence({
		sourceJson: source.formattedText,
		trackId: selection[0].trackId,
		elementIds: selection.map((item) => item.elementId),
	});
	return result.valid
		? {
				...result,
				baseRevision: source.baseRevision,
				projectId: project.metadata.id,
				sceneId: scene.id,
			}
		: null;
}

export async function restoreSelectedSilence({
	editor,
	selection,
}: {
	editor: EditorCore;
	selection: Selection;
}) {
	// Freeze the requested clip boundaries before async session preparation.
	// The commit below rejects a scene/revision change instead of widening the edit.
	const preview = previewRestoreSilence({ editor, selection });
	if (!preview)
		throw new Error("בחרו קליפים צמודים מאותו סרטון שיש ביניהם זמן מקור שנמחק");
	await editor.command.enableCanonical();
	const parsed = parseTimelineDocumentV2({ text: preview.sourceJson });
	const value = parsed.value;
	if (!parsed.valid || !value)
		throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
	editor.command.executeSilenceTransaction({
		operation: "restore",
		execute: () => {
			const project = editor.project.getActive();
			const scene = editor.scenes.getActiveScene();
			if (
				project.metadata.id !== preview.projectId ||
				scene.id !== preview.sceneId ||
				buildTimelineDocumentV2({ project, scene }).baseRevision !==
					preview.baseRevision
			)
				throw new Error("הטיימליין השתנה. בחרו שוב את הקליפים.");
			editor.scenes.setScenes({
				scenes: updateSceneInArray({
					scenes: editor.scenes.getScenes(),
					sceneId: scene.id,
					updates: { tracks: value.tracks, bookmarks: value.bookmarks },
				}),
				activeSceneId: scene.id,
			});
			editor.save.markDirty();
		},
	});
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	return {
		...preview,
		restoredRevision: buildTimelineDocumentV2({ project, scene }).baseRevision,
	};
}

export type SilenceRestoration = Awaited<
	ReturnType<typeof restoreSelectedSilence>
>;
