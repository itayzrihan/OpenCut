import { Command, type CommandResult } from "@/commands/base-command";
import { BatchCommand } from "@/commands/batch-command";
import { EditorCore } from "@/core";
import { getDisplayTracks } from "@/timeline";
import {
	buildTextTransitionSfxElement,
	TEXT_TRANSITION_SFX_KIND,
	TEXT_TRANSITION_SFX_KIND_PARAM,
	TEXT_TRANSITION_SFX_TEXT_ID_PARAM,
} from "@/transitions/text-transition-sfx";
import { ApplyTransitionCommand } from "./apply-transition";
import { DeleteElementsCommand } from "./delete-elements";
import { InsertElementCommand } from "./insert-element";

type TransitionApplication = ConstructorParameters<
	typeof ApplyTransitionCommand
>[0][number];

/** Applies text transitions and their managed companion audio as one undo step. */
export class ApplyTextTransitionsWithSfxCommand extends Command {
	private batch: BatchCommand | null = null;

	constructor(private readonly applications: TransitionApplication[]) {
		super();
	}

	execute(): CommandResult | undefined {
		if (!this.batch) {
			this.batch = this.buildBatch();
		}
		this.batch.execute();
		// Keep the current text selection; inserted companion clips are implementation detail.
		return undefined;
	}

	undo(): void {
		this.batch?.undo();
	}

	private buildBatch(): BatchCommand {
		const tracks = EditorCore.getInstance().scenes.getActiveScene().tracks;
		const targetTextIds = new Set(
			this.applications.map((application) => application.elementId),
		);
		const managedCompanions = tracks.audio.flatMap((track) =>
			track.elements.flatMap((element) =>
				element.params[TEXT_TRANSITION_SFX_KIND_PARAM] ===
					TEXT_TRANSITION_SFX_KIND &&
				typeof element.params[TEXT_TRANSITION_SFX_TEXT_ID_PARAM] === "string" &&
				targetTextIds.has(
					element.params[TEXT_TRANSITION_SFX_TEXT_ID_PARAM] as string,
				)
					? [{ trackId: track.id, elementId: element.id }]
					: [],
			),
		);

		const commands: Command[] = [new ApplyTransitionCommand(this.applications)];
		if (managedCompanions.length > 0) {
			commands.push(new DeleteElementsCommand({ elements: managedCompanions }));
		}

		for (const application of this.applications) {
			const track = getDisplayTracks({ tracks }).find(
				(candidate) => candidate.id === application.trackId,
			);
			const textElement = track?.elements.find(
				(element) => element.id === application.elementId,
			);
			if (!textElement || textElement.type !== "text") continue;
			const audioElement = buildTextTransitionSfxElement({
				textElement,
				transitionId: application.presetId,
				side: application.side,
				percent: application.percent,
			});
			if (!audioElement) continue;
			commands.push(
				new InsertElementCommand({
					element: audioElement,
					placement: { mode: "auto", trackType: "audio" },
				}),
			);
		}

		return new BatchCommand(commands);
	}
}
