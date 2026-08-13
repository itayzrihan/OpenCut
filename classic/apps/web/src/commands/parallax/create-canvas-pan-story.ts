import { Command, type CommandResult } from "@/commands/base-command";
import { InsertElementCommand } from "@/commands/timeline/element/insert-element";
import { EditorCore } from "@/core";
import {
	buildCanvasPanElement,
	buildCanvasPanScene,
	linkParallaxSceneToElement,
	type CanvasPanSetup,
} from "@/parallax-story-teller/model";
import type { TScene } from "@/timeline";
import type { MediaTime } from "@/wasm";

export class CreateCanvasPanStoryCommand extends Command {
	private readonly childScene: TScene;
	private readonly insertCommand: InsertElementCommand;
	private savedScenes: TScene[] | null = null;

	constructor({
		parentSceneId,
		startTime,
		setup,
	}: {
		parentSceneId: string;
		startTime: MediaTime;
		setup: CanvasPanSetup;
	}) {
		super();
		const childScene = buildCanvasPanScene({ parentSceneId, setup });
		const insertCommand = new InsertElementCommand({
			placement: { mode: "auto", trackType: "effect" },
			element: buildCanvasPanElement({
				sceneId: childScene.id,
				startTime,
				setup,
			}),
		});
		this.childScene = linkParallaxSceneToElement({
			scene: childScene,
			elementId: insertCommand.getElementId(),
		});
		this.insertCommand = insertCommand;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const parentSceneId = this.childScene.parallax?.parentSceneId;
		if (!parentSceneId) return;
		const parentScene = editor.scenes
			.getScenes()
			.find((scene) => scene.id === parentSceneId);
		if (!parentScene) return;

		if (!this.savedScenes) {
			this.savedScenes = [...editor.scenes.getScenes()];
		}
		editor.scenes.setScenes({
			scenes: [...this.savedScenes, this.childScene],
			activeSceneId: parentSceneId,
		});
		return this.insertCommand.execute();
	}

	undo(): void {
		this.insertCommand.undo();
		if (!this.savedScenes) return;
		const editor = EditorCore.getInstance();
		editor.scenes.setScenes({
			scenes: this.savedScenes,
			activeSceneId: this.childScene.parallax?.parentSceneId,
		});
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}

	getElementId(): string {
		return this.insertCommand.getElementId();
	}

	getSceneId(): string {
		return this.childScene.id;
	}
}
