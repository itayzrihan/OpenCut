import type { EditorCore } from "@/core";
import { getDisplayTracks } from "@/timeline";
import { DEFAULT_TRANSITION_PERCENT } from "./apply";
import {
	arrangeOverlappingTextTransitions,
	getOverlappingTextTransitionEntries,
	type TextTransitionArrangeEntry,
} from "./arrange-text-overlaps";

const DEFAULT_TEXT_TRANSITION_PRESET_ID = "fade";

/**
 * Standalone version of the properties panel's "Apply & arrange all text":
 * applies the default fade-in/fade-out (5%) to every overlapping text layer
 * in the active scene, then closes the resulting handoff gaps. Unlike the
 * panel version, this needs no selected element.
 */
export function applyAndArrangeAllTextTransitions({
	editor,
}: {
	editor: EditorCore;
}): boolean {
	const entries: TextTransitionArrangeEntry[] = getDisplayTracks({
		tracks: editor.scenes.getActiveScene().tracks,
	}).flatMap((track) =>
		track.type === "text"
			? track.elements.map((element) => ({ trackId: track.id, element }))
			: [],
	);

	const overlappingEntries = getOverlappingTextTransitionEntries(entries);
	if (overlappingEntries.length < 2) return false;

	editor.timeline.applyTextTransitionsWithSfx({
		applications: overlappingEntries.flatMap(({ trackId, element }) => [
			{
				trackId,
				elementId: element.id,
				presetId: DEFAULT_TEXT_TRANSITION_PRESET_ID,
				side: "in" as const,
				percent: DEFAULT_TRANSITION_PERCENT,
			},
			{
				trackId,
				elementId: element.id,
				presetId: DEFAULT_TEXT_TRANSITION_PRESET_ID,
				side: "out" as const,
				percent: DEFAULT_TRANSITION_PERCENT,
			},
		]),
	});

	const refreshedEntries = editor.timeline
		.getElementsWithTracks({
			elements: overlappingEntries.map(({ trackId, element }) => ({
				trackId,
				elementId: element.id,
			})),
		})
		.flatMap(({ track, element }) =>
			element.type === "text" ? [{ trackId: track.id, element }] : [],
		);
	const updates = arrangeOverlappingTextTransitions({ entries: refreshedEntries });
	if (updates.length > 0) {
		editor.timeline.updateElements({ updates });
	}
	return true;
}
