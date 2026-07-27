import { buildBackgroundRemovalEdit } from "@/background-removal";
import type { BackgroundRemovalSettings } from "@/background-removal";
import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { ElementRef, SceneTracks } from "@/timeline";
import { generateUUID } from "@/utils/id";

export class SetBackgroundRemovalCommand extends Command {
	private savedState: SceneTracks | null = null;
	private target: ElementRef | null = null;
	private readonly duplicateElementId = generateUUID();
	private readonly duplicateTrackId = generateUUID();

	constructor(
		private readonly params: {
			trackId: string;
			elementId: string;
			settings: BackgroundRemovalSettings;
			duplicate: boolean;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const result = buildBackgroundRemovalEdit({
			tracks: this.savedState,
			...this.params,
			duplicateElementId: this.duplicateElementId,
			duplicateTrackId: this.duplicateTrackId,
		});
		if (!result) return undefined;

		this.target = result.target;
		editor.timeline.updateTracks(result.tracks);
		return createElementSelectionResult([result.target]);
	}

	undo(): void {
		if (!this.savedState) return;
		EditorCore.getInstance().timeline.updateTracks(this.savedState);
	}

	getTarget(): ElementRef | null {
		return this.target;
	}
}
