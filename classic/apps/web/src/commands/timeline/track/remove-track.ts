import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";
import { withRemovedTrackOrder } from "@/timeline";
import {
	removeCaptionElementWordsFromSource,
	removeTextLayerWordsFromCaptionSource,
} from "@/subtitles/caption-source-sync";

export class RemoveTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const removedElements = [
			...this.savedState.overlay,
			...this.savedState.audio,
		]
			.filter((track) => track.id === this.trackId)
			.flatMap((track) =>
				track.elements.map((element) => ({
					trackId: track.id,
					elementId: element.id,
				})),
			);
		let updatedTracks: SceneTracks = withRemovedTrackOrder({
			trackId: this.trackId,
			tracks: {
				...this.savedState,
				overlay: this.savedState.overlay.filter(
					(track) => track.id !== this.trackId,
				),
				audio: this.savedState.audio.filter(
					(track) => track.id !== this.trackId,
				),
			},
		});
		updatedTracks = removeCaptionElementWordsFromSource({
			tracks: updatedTracks,
			previousTracks: this.savedState,
			elements: removedElements,
		});
		updatedTracks = removeTextLayerWordsFromCaptionSource({
			tracks: updatedTracks,
			elements: removedElements,
		});
		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
