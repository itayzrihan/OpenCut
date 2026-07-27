import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";
import { withReorderedTrack } from "@/timeline";

export class ReorderTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor({
		trackId,
		toIndex,
	}: {
		trackId: string;
		toIndex: number;
	}) {
		super();
		this.trackId = trackId;
		this.toIndex = toIndex;
	}

	private readonly trackId: string;
	private readonly toIndex: number;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(
			withReorderedTrack({
				tracks: this.savedState,
				trackId: this.trackId,
				toIndex: this.toIndex,
			}),
		);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
