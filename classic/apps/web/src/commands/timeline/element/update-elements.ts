import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { findTrackInSceneTracks, updateElementInSceneTracks } from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import {
	syncCaptionSourceWordsFromElements,
	syncTextLayerWordsIntoCaptionSource,
} from "@/subtitles/caption-source-sync";
import { rippleCaptionSources } from "@/timeline/group-resize/ripple-caption-sources";
import type { GroupResizeResult } from "@/timeline/group-resize/types";

function retainTrackElements<T extends TimelineTrack>({
	track,
	removedIds,
}: {
	track: T;
	removedIds: Set<string>;
}): T {
	return {
		...track,
		elements: track.elements.filter((element) => !removedIds.has(element.id)),
	};
}

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly captionTimeEdit?: GroupResizeResult["timeEdit"];
	private readonly removedElementIds: Set<string>;
	private readonly updates: Array<{
		trackId: string;
		elementId: string;
		patch: Partial<TimelineElement>;
	}>;

	constructor({
		updates,
		captionTimeEdit,
		removedElementIds = [],
	}: {
		captionTimeEdit?: GroupResizeResult["timeEdit"];
		removedElementIds?: string[];
		updates: Array<{
			trackId: string;
			elementId: string;
			patch: Partial<TimelineElement>;
		}>;
	}) {
		super();
		this.updates = updates;
		this.captionTimeEdit = captionTimeEdit;
		this.removedElementIds = new Set(removedElementIds);
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let updatedTracks = this.savedState;
		if (this.removedElementIds.size) {
			updatedTracks = {
				...updatedTracks,
				main: {
					...updatedTracks.main,
					elements: updatedTracks.main.elements.filter(
						(element) => !this.removedElementIds.has(element.id),
					),
				},
				overlay: updatedTracks.overlay.map((track) =>
					retainTrackElements({ track, removedIds: this.removedElementIds }),
				),
				audio: updatedTracks.audio.map((track) => ({
					...track,
					elements: track.elements.filter(
						(element) => !this.removedElementIds.has(element.id),
					),
				})),
			};
		}

		for (const updateEntry of this.updates) {
			const currentTrack = findTrackInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
			});
			const currentElement = currentTrack?.elements.find(
				(element) => element.id === updateEntry.elementId,
			);
			if (!currentTrack || !currentElement) {
				continue;
			}

			const nextElement = applyElementUpdate({
				element: currentElement,
				patch: updateEntry.patch,
				context: {
					tracks: updatedTracks,
					trackId: updateEntry.trackId,
				},
			});

			updatedTracks = updateElementInSceneTracks({
				tracks: updatedTracks,
				trackId: updateEntry.trackId,
				elementId: updateEntry.elementId,
				update: () => nextElement,
			});
		}

		if (this.captionTimeEdit) {
			updatedTracks = rippleCaptionSources({
				tracks: updatedTracks,
				...this.captionTimeEdit,
			});
		} else {
			updatedTracks = syncCaptionSourceWordsFromElements({
				tracks: updatedTracks,
				previousTracks: this.savedState,
				updates: this.updates,
			});
			updatedTracks = syncTextLayerWordsIntoCaptionSource({
				tracks: updatedTracks,
				elements: this.updates,
			});
		}

		editor.timeline.updateTracks(updatedTracks, {
			captionsAlreadySynced: Boolean(this.captionTimeEdit),
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState, {
				captionsAlreadySynced: Boolean(this.captionTimeEdit),
			});
		}
	}
}
