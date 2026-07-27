import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import {
	findTrackInSceneTracks,
	updateElementInSceneTracks,
	type SceneTracks,
} from "@/timeline";
import { buildTransitionPatch } from "@/transitions";

export class ApplyTransitionCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private readonly applications: Array<{
			trackId: string;
			elementId: string;
			presetId: string;
			side: "in" | "out";
			percent?: number;
		}>,
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		let updatedTracks = this.savedState;

		for (const application of this.applications) {
			const track = findTrackInSceneTracks({
				tracks: updatedTracks,
				trackId: application.trackId,
			});
			const element = track?.elements.find(
				(trackElement) => trackElement.id === application.elementId,
			);
			if (!track || !element || element.type === "audio" || element.type === "effect") {
				continue;
			}

			const patch = buildTransitionPatch({
				element,
				presetId: application.presetId,
				side: application.side,
				percent: application.percent,
			});
			const nextElement = {
				...element,
				...patch,
			} as typeof element;

			updatedTracks = updateElementInSceneTracks({
				tracks: updatedTracks,
				trackId: application.trackId,
				elementId: application.elementId,
				update: () => nextElement,
			});
		}

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}
}
