import { BatchCommand } from "@/commands/batch-command";
import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { TextCaptionRevealMode, TimelineElement } from "@/timeline";
import { getDisplayTracks } from "@/timeline";
import {
	buildTypingRevealSfxElements,
	TYPING_REVEAL_SFX_ASSET_ID,
	TYPING_REVEAL_SFX_KIND,
	TYPING_REVEAL_SFX_KIND_PARAM,
	TYPING_REVEAL_SFX_TEXT_ID_PARAM,
} from "@/text/typing-reveal-sfx";
import { DeleteElementsCommand } from "./delete-elements";
import { InsertElementCommand } from "./insert-element";
import { UpdateElementsCommand } from "./update-elements";

interface TextRevealUpdate {
	trackId: string;
	elementId: string;
	patch: Partial<TimelineElement>;
}

/** Updates layer reveal settings and keeps its typing audio companion in sync. */
export class UpdateTextRevealWithTypingSfxCommand extends Command {
	private batch: BatchCommand | null = null;

	constructor(
		private readonly params: {
			updates: TextRevealUpdate[];
			revealMode: TextCaptionRevealMode;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		if (!this.batch) this.batch = this.buildBatch();
		this.batch.execute();
		return undefined;
	}

	undo(): void {
		this.batch?.undo();
	}

	private buildBatch(): BatchCommand {
		const tracks = EditorCore.getInstance().scenes.getActiveScene().tracks;
		const targetTextElements = this.params.updates.flatMap((update) => {
			const track = getDisplayTracks({ tracks }).find(
				(candidate) => candidate.id === update.trackId,
			);
			const element = track?.elements.find(
				(candidate) => candidate.id === update.elementId,
			);
			return element?.type === "text" ? [element] : [];
		});
		const targetIds = new Set(targetTextElements.map((element) => element.id));
		const companions = new Map<
			string,
			{ trackId: string; elementId: string }
		>();

		for (const track of tracks.audio) {
			for (const audio of track.elements) {
				const linkedTextId = audio.params[TYPING_REVEAL_SFX_TEXT_ID_PARAM];
				const isManaged =
					audio.params[TYPING_REVEAL_SFX_KIND_PARAM] ===
						TYPING_REVEAL_SFX_KIND &&
					typeof linkedTextId === "string" &&
					targetIds.has(linkedTextId);
				const matchesAuthoredExample =
					audio.sourceType === "library" &&
					audio.libraryAssetId === TYPING_REVEAL_SFX_ASSET_ID &&
					targetTextElements.some((text) =>
						stronglyOverlaps({
							firstStart: audio.startTime,
							firstDuration: audio.duration,
							secondStart: text.startTime,
							secondDuration: text.duration,
						}),
					);
				if (isManaged || matchesAuthoredExample) {
					companions.set(audio.id, {
						trackId: track.id,
						elementId: audio.id,
					});
				}
			}
		}

		const commands: Command[] = [
			new UpdateElementsCommand({ updates: this.params.updates }),
		];
		if (companions.size > 0) {
			commands.push(
				new DeleteElementsCommand({ elements: [...companions.values()] }),
			);
		}
		if (this.params.revealMode === "letter-by-letter") {
			for (const textElement of targetTextElements) {
				for (const audioElement of buildTypingRevealSfxElements({
					textElement,
				})) {
					commands.push(
						new InsertElementCommand({
							element: audioElement,
							placement: { mode: "auto", trackType: "audio" },
						}),
					);
				}
			}
		}

		return new BatchCommand(commands);
	}
}

function stronglyOverlaps({
	firstStart,
	firstDuration,
	secondStart,
	secondDuration,
}: {
	firstStart: number;
	firstDuration: number;
	secondStart: number;
	secondDuration: number;
}): boolean {
	const overlap = Math.max(
		0,
		Math.min(firstStart + firstDuration, secondStart + secondDuration) -
			Math.max(firstStart, secondStart),
	);
	return overlap >= Math.min(firstDuration, secondDuration) * 0.7;
}
