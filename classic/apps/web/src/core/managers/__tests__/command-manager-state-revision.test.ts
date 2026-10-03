/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- the test supplies the minimal EditorCore surface used by CommandManager */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Command } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import { readFileSync } from "node:fs";
import type { TProject } from "@/project/types";
import type { SerializedProject } from "@/services/storage/types";

mock.module("@/ripple", () => ({
	computeRippleAdjustments: () => {
		throw new Error("Ripple is disabled in this test");
	},
	applyRippleAdjustments: () => {
		throw new Error("Ripple is disabled in this test");
	},
}));
mock.module("@/timeline/scenes", () => ({
	getProjectDurationFromScenes: () => {
		throw new Error("Fixtures have explicit duration");
	},
}));

mock.module("@/services/storage/service", () => ({
	storageService: { saveCommandHistory: async () => undefined },
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

test("history preserves complete scene metadata and future project fields", async () => {
	const fixture = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as { document: SerializedProject };
	let project: TProject = {
		...fixture.document,
		metadata: {
			...fixture.document.metadata,
			createdAt: new Date(fixture.document.metadata.createdAt),
			updatedAt: new Date(fixture.document.metadata.updatedAt),
		},
		scenes: fixture.document.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
	};
	const original = structuredClone(project);
	const editor = {
		project: {
			getActiveOrNull: () => project,
			setActiveProject: ({ project: next }: { project: TProject }) => {
				project = next;
			},
		},
		scenes: {
			getScenes: () => project.scenes,
			initializeScenes: ({ scenes }: { scenes: TProject["scenes"] }) => {
				project.scenes = scenes;
			},
		},
		selection: {
			getSnapshot: () => ({
				selectedElements: [],
				selectedTextWords: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			}),
			restoreSnapshot: () => undefined,
		},
		save: {
			pause: () => undefined,
			resume: () => undefined,
			markDirty: () => undefined,
		},
	} as unknown as EditorCore;
	const manager = new CommandManager(editor);
	const before = manager.captureProjectSnapshot();
	expect(before?.metadata).not.toHaveProperty("thumbnail");
	expect(before?.scenes[0].parallax).toEqual(original.scenes[0].parallax);
	manager.executeTransaction({
		execute: () => {
			project.scenes[0].name = "Changed";
			project.hyperframesCompositions = {
				source: {
					source: {
						entryFile: "index.html",
						files: { "index.html": "<div>שלום</div>" },
						resourceAssetIds: {},
					},
					compositionId: "main",
					width: 720,
					height: 1280,
					fps: 30,
					durationSeconds: 6,
				},
			};
		},
	});
	const after = structuredClone(project);
	manager.undo();
	expect(project).toEqual({
		...original,
		aiEditHistory: original.aiEditHistory ?? [],
	});
	manager.redo();
	expect(project).toEqual(after);
	await manager.flushHistory();
});
