import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { Bookmark } from "@/timeline";
import { updateSceneInArray } from "@/timeline/scenes";

/** Atomically replaces one scene's whole bookmark array — the bulk-write counterpart to
 * TracksSnapshotCommand, used when several bookmarks need to be created/changed as one unit
 * (e.g. reorganize-takes marking a whole cluster of duplicate-take bookmarks at once). */
export class SetBookmarksCommand extends Command {
	constructor(private options: { sceneId: string; before: Bookmark[]; after: Bookmark[] }) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		const updatedScenes = updateSceneInArray({
			scenes,
			sceneId: this.options.sceneId,
			updates: { bookmarks: this.options.after },
		});
		editor.scenes.setScenes({ scenes: updatedScenes });
		return undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();
		const scenes = editor.scenes.getScenes();
		const updatedScenes = updateSceneInArray({
			scenes,
			sceneId: this.options.sceneId,
			updates: { bookmarks: this.options.before },
		});
		editor.scenes.setScenes({ scenes: updatedScenes });
	}
}
