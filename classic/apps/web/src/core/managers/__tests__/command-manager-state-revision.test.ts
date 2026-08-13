/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the test supplies the minimal EditorCore surface used by CommandManager */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Command } from "@/commands/base-command";
import type { EditorCore } from "@/core";

mock.module("opencut-wasm", () => ({
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({ clips: options.clips, timelineDuration: 0 }),
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	normalizeTextLayerWordIds: <T extends { wordRuns: unknown[] }>(options: T) =>
		options.wordRuns,
}));

let CommandManager: typeof import("@/core/managers/commands").CommandManager;

beforeAll(async () => {
	({ CommandManager } = await import("@/core/managers/commands"));
});

class CounterCommand extends Command {
	constructor(private state: { value: number }) {
		super();
	}

	override get canPersistHistory(): boolean {
		return false;
	}

	execute(): undefined {
		this.state.value += 1;
	}

	override undo(): void {
		this.state.value -= 1;
	}
}

function createManager() {
	const editor = {
		project: {
			getActiveOrNull: () => null,
		},
		selection: {
			getSnapshot: () => ({
				selectedElements: [],
				selectedTextWords: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
		},
	} as unknown as EditorCore;
	return new CommandManager(editor);
}

describe("CommandManager state revision", () => {
	test("changes across execute, undo, and redo so async commits can go stale", () => {
		const manager = createManager();
		const state = { value: 0 };
		const initialRevision = manager.getStateRevision();

		manager.execute({ command: new CounterCommand(state) });
		const executedRevision = manager.getStateRevision();
		expect(executedRevision).toBeGreaterThan(initialRevision);

		manager.undo();
		const undoneRevision = manager.getStateRevision();
		expect(undoneRevision).toBeGreaterThan(executedRevision);
		expect(manager.canRedo()).toBe(true);

		manager.redo();
		expect(manager.getStateRevision()).toBeGreaterThan(undoneRevision);
		expect(state.value).toBe(1);
	});
});
