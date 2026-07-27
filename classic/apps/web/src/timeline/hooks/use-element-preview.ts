import { useEditor, useEditorTimelineScenes } from "@/editor/use-editor";
import { findTrackInSceneTracks, type TimelineElement } from "@/timeline";

/**
 * Subscribes to render tracks and returns the live (preview-aware) version of
 * an element alongside helpers for previewing and committing updates.
 *
 * Use this wherever property fields need to reflect in-progress preview state
 * (e.g. a slider being dragged) rather than the last committed value.
 */
export function useElementPreview<T extends TimelineElement>({
	trackId,
	elementId,
	fallback,
}: {
	trackId: string;
	elementId: string;
	fallback: T;
}) {
	const editor = useEditor();
	const [previewTracks, activeSceneTracks] = useEditorTimelineScenes((e) => [
		e.timeline.getPreviewTracks(),
		e.scenes.getActiveScene().tracks,
	]);

	const previewTrack = findTrackInSceneTracks({
		tracks: previewTracks ?? activeSceneTracks,
		trackId,
	});
	const previewElement = previewTrack?.elements.find(
		(element): element is T =>
			element.id === elementId && element.type === fallback.type,
	);
	const renderElement = previewElement ?? fallback;

	const previewUpdates = (updates: Partial<TimelineElement>) =>
		editor.timeline.previewElements({
			updates: [{ trackId, elementId, updates }],
		});

	const commit = () => editor.timeline.commitPreview();

	return { renderElement, previewUpdates, commit };
}
