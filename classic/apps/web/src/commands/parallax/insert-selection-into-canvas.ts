import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import {
	insertSelectionIntoCanvas,
	type InsertSelectionMode,
} from "@/parallax-story-teller/insert-selection";
import type { ElementRef, TScene } from "@/timeline/types";

export class InsertSelectionIntoCanvasCommand extends Command {
	private savedScenes: TScene[] | null = null;
	private savedActiveSceneId: string | null = null;

	constructor(
		private readonly input: {
			parentSceneId: string;
			parallaxElementId: string;
			selectedElements: ElementRef[];
			mode: InsertSelectionMode;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		if (!this.savedScenes) {
			this.savedScenes = [...editor.scenes.getScenes()];
			this.savedActiveSceneId = editor.scenes.getActiveSceneOrNull()?.id ?? null;
		}
		const result = insertSelectionIntoCanvas({
			scenes: this.savedScenes,
			...this.input,
		});
		if (!result) return;
		editor.scenes.setScenes({
			scenes: result.scenes,
			activeSceneId: this.input.parentSceneId,
		});
		return {
			selection: {
				selectedElements: [result.parentElementRef],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (!this.savedScenes) return;
		const editor = EditorCore.getInstance();
		editor.scenes.setScenes({
			scenes: this.savedScenes,
			activeSceneId: this.savedActiveSceneId ?? undefined,
		});
	}
}
