import { setBatchReadOnlyProjects, acknowledgeAutomationReload, automationReadVersion } from "@/batch/read-only";
import { mockFetch } from "@/test-support/mock-fetch";
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal browser/renderer fixtures; canonical state and storage policy use real WASM. */
import { beforeAll, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { EditorCore } from "@/core";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { TProject } from "@/project/types";
import type { SerializedProject } from "@/services/storage/types";
import type { MediaAsset } from "@/media/types";
import type { TScene } from "@/timeline/types";
import { createCanonicalTestRuntime } from "../../__tests__/canonical-runtime-fixture";

let fixture: CanonicalClassicSnapshot;
// This lifecycle suite stubs renderers/fonts; effect catalog parity is covered
// by canonical-command-manager.test.ts with the real product definitions.
// Animation metadata/resolver parity is covered by product-catalog.test.ts;
// importing render-time definitions here would mix them with DEFAULTS/font stubs.
mock.module("@/animation/product-catalog", () => ({
	bindProductAnimationCatalog: (publish: (groups: unknown) => void) => {
		publish([]);
		return () => {};
	},
}));
mock.module("@/effects", () => ({
	registerDefaultEffects: () => {},
	effectsRegistry: { catalog: () => [], subscribe: () => () => {} },
}));
mock.module("@/masks", () => ({
	registerDefaultMasks: () => {},
	masksRegistry: { catalog: () => [], subscribe: () => () => {} },
}));
let record = "";
let transition: typeof import("opencut-editor-runtime-wasm").sessionStoreTransition;
function deserialize(serialized: SerializedProject): TProject {
	return {
		...serialized,
		metadata: {
			...serialized.metadata,
			createdAt: new Date(serialized.metadata.createdAt),
			updatedAt: new Date(serialized.metadata.updatedAt),
		},
		scenes: serialized.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
	};
}
mock.module("@/services/storage/service", () => ({
	deserializeProject: deserialize,
	storageService: {
		ensureBrowserDataMigrated: async () => {},
		createDriveMigrationDependencies: () => ({}),
		loadProject: async () => ({
			project: deserialize({
				...fixture.document,
				metadata: {
					...fixture.document.metadata,
					thumbnail: "data:image/webp;base64,fixture",
				},
			}),
		}),
		loadAllProjectFonts: async () => [],
		loadAllSharedFonts: async () => [],
		saveProject: async () => {
			throw new Error("Legacy save bypassed atomic storage");
		},
		saveCommandHistory: async () => {
			throw new Error("Independent history save is forbidden");
		},
	},
}));
mock.module("@/core/load-canonical-runtime", () => ({
	loadCanonicalRuntime: createCanonicalTestRuntime,
}));
mock.module("@/services/storage/migrations", () => ({
	CURRENT_PROJECT_VERSION: 33,
	migrations: [],
	runStorageMigrations: async () => ({ migratedCount: 0, failures: [] }),
}));
mock.module("@/commands/project", () => ({
	UpdateProjectSettingsCommand: class {},
}));
mock.module("@/services/renderer/scene-builder", () => ({
	buildScene: () => {
		throw new Error("Unexpected render");
	},
}));
mock.module("@/services/renderer/canvas-renderer", () => ({
	CanvasRenderer: class {},
}));
mock.module("@/fonts/google-fonts", () => ({ loadFonts: async () => {} }));
mock.module("@/fonts/custom-fonts", () => ({
	buildUniqueFontFamily: () => "",
	getSupportedFontMimeType: () => null,
	isSupportedFontFile: () => false,
	loadProjectFont: async () => {},
}));
mock.module("@/timeline/smart-takes/audio-evidence", () => ({
	collectTakeAudioEvidence: () => { throw new Error("No audio analysis during session handoff"); },
}));
mock.module("@/timeline/element-utils", () => ({
	getElementFontFamilies: () => [],
}));
mock.module("@/fps/defaults", () => ({
	DEFAULT_FPS: { numerator: 30, denominator: 1 },
}));
mock.module("@/fps/utils", () => ({
	getRaisedProjectFpsForImportedMedia: () => null,
}));
mock.module("@/timeline/defaults", () => ({ DEFAULTS: {} }));
mock.module("@/timeline/scenes", () => ({
	buildDefaultScene: () => {},
	getProjectDurationFromScenes: () => fixture.document.metadata.duration,
}));
mock.module("@/project/archive/project-archive", () => ({
	createProjectArchive: async () => {},
	importProjectArchive: async () => {},
}));
mock.module("@/ripple", () => ({
	computeRippleAdjustments: () => [],
	applyRippleAdjustments: () => {},
}));

let ProjectManager: typeof import("../project-manager").ProjectManager;
let CommandManager: typeof import("../commands").CommandManager;
beforeAll(async () => {
	fixture = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	fixture.document.customFonts = [];
	const runtime = await createCanonicalTestRuntime();
	runtime.free();
	const glue =
		await import("../../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
	transition = glue.sessionStoreTransition;
	({ ProjectManager } = await import("../project-manager"));
	({ CommandManager } = await import("../commands"));
});
function host() {
	let scenes: TScene[] = [];
	let assets: MediaAsset[] = [];
	const selection = {
		selectedElements: [],
		selectedTextWords: [],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	};
	const editor = {
		get project() {
			return project;
		},
		get command() {
			return command;
		},
		scenes: {
			getScenes: () => scenes,
			getActiveSceneOrNull: () => scenes[0] ?? null,
			clearScenes: () => {
				scenes = [];
			},
			initializeScenes: ({ scenes: next }: { scenes: TScene[] }) => {
				scenes = next;
			},
		},
		media: {
			getAssets: () => assets,
			clearAllAssets: () => {
				assets = [];
			},
			setAssets: ({ assets: next }: { assets: MediaAsset[] }) => {
				assets = next;
			},
			loadProjectMedia: async () => {
				assets = fixture.mediaAssets;
			},
		},
		save: {
			pause: () => {},
			resume: () => {},
			discardPending: () => {},
			markDirty: () => {},
			getIsDirty: () => false,
			flush: async () => {
				await project.saveCurrentProject();
			},
		},
		selection: { getSnapshot: () => selection, restoreSnapshot: () => {} },
	} as unknown as EditorCore;
	const project = new ProjectManager(editor);
	const command = new CommandManager(editor);
	return {
		editor,
		project,
		command,
		dispose: () => {
			project.dispose();
			command.detachCanonical();
		},
	};
}
test("opening, autosaving and reopening restores one project/history/run and preserves thumbnails", async () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		value: {
			__opencutAccountId: "alice",
			location: { origin: "http://127.0.0.1:3100" },
		},
		configurable: true,
	});
	const calls: string[] = [];
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			calls.push(body.request.type);
			try {
				const next = transition(
					record,
					"alice",
					"classic-project",
					body.request,
					Date.now(),
				);
				record = next.record;
				return Response.json({
					...next.result,
					legacyProject: next.project
						? null
						: {
								...fixture.document,
								metadata: {
									...fixture.document.metadata,
									thumbnail: "data:image/webp;base64,fixture",
								},
							},
					legacyHistory: null,
				});
			} catch (error) {
				return Response.json(
					{ error: String(error), definitive: true },
					{ status: 409 },
				);
			}
		}),
	);
	const first = host();
	const second = host();
	const third = host();
	Object.defineProperty(first.project, "updateThumbnailFromTimeline", {value: async () => false});
	try {
		expect(await first.project.loadProject({ id: "classic-project" })).toBe(
			true,
		);
		const initialSettings = structuredClone(first.project.getActive().settings);
		await first.project.updateSettings({
			settings: { background: { type: "color", color: "#111111" } },
			pushHistory: false,
		});
		await first.project.updateSettings({
			settings: { background: { type: "color", color: "#222222" } },
			pushHistory: false,
		});
		await first.project.updateSettings({
			settings: { background: { type: "color", color: "#222222" } },
		});
		expect(first.project.getActive().settings.background).toEqual({
			type: "color",
			color: "#222222",
		});
		first.command.undo();
		expect(first.project.getActive().settings).toEqual(initialSettings);
		expect(() =>
			first.command.executeTransaction({
				execute: () => {
					first.project.updateSettings({
						settings: { canvasSize: { width: 500, height: 500 } },
						pushHistory: false,
					});
					first.project.updateSettings({
						settings: { fps: { numerator: 0, denominator: 1 } },
						pushHistory: false,
					});
				},
			}),
		).toThrow();
		expect(first.project.getActive().settings).toEqual(initialSettings);
		const run = await first.command.startEditingAgent({
			runId: "load-save-run",
			request: "Change the title",
		});
		first.command.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "project.classic.commit",
		});
		first.command.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Rename", status: "inProgress" }],
		});
		const classic = structuredClone(fixture);
		classic.document.metadata.name = "Latest saved film";
		first.command.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "rename",
			id: "project.classic.commit",
			input: { classic },
		});
		const beforeSave = first.command.captureEditingSession().archive;
		await first.project.saveCurrentProject();
		await first.command.flushHistory();
		expect(first.command.captureEditingSession().archive).toEqual(beforeSave);
		expect(first.command.prepareEditingAgentReview().revision).toBe(
			first.command.getEditingAgentSnapshot()!.revision!,
		);
		await first.project.prepareExit();
		first.project.closeProject();
		const { renameSavedEditorProject } =
			await import("@/editor-agent/saved-project");
		const renamed = await renameSavedEditorProject({
			projectId: "classic-project",
			name: "Library renamed film",
		});
		expect(renamed?.metadata.name).toBe("Library renamed film");
		expect(await second.project.loadProject({ id: "classic-project" })).toBe(
			true,
		);
		expect(second.project.getActive().metadata.name).toBe(
			"Library renamed film",
		);
		expect(second.project.getActive().metadata.thumbnail).toBe(
			"data:image/webp;base64,fixture",
		);
		expect(second.command.getEditingAgentSnapshot()?.phase).toBe("paused");
		second.command.undo();
		expect(second.project.getActive().metadata.name).toBe("Latest saved film");
		second.command.undo();
		expect(second.project.getActive().metadata.name).toBe(
			fixture.document.metadata.name,
		);
		await second.command.flushHistory();
		expect(calls.filter((type) => type === "acquire")).toHaveLength(3);
		expect(calls).toContain("release");
		await third.project.loadProject({ id: "classic-project" });
		expect(third.project.getSessionReadOnlyReason()).toContain(
			"another editor",
		);
		expect(() => third.command.undo()).toThrow("another editor");
		expect(() =>
			third.project.updateSettings({
				settings: { canvasSize: { width: 1080, height: 1920 } },
			}),
		).toThrow("another editor");
		const acquisitionsBefore = calls.filter(
			(type) => type === "acquire",
		).length;
		const takeover = third.project.takeOverEditorSession();
		const repeatedLoad = third.project.loadProject({ id: "classic-project" });
		await Promise.all([takeover, repeatedLoad]);
		expect(calls.filter((type) => type === "acquire")).toHaveLength(
			acquisitionsBefore + 1,
		);
		expect(third.project.getSessionReadOnlyReason()).toBeNull();
		const savedBeforeStaleWrite = record;
		await expect(second.project.saveCurrentProject()).rejects.toThrow(
			"ownership",
		);
		expect(record).toBe(savedBeforeStaleWrite);
		expect(second.project.getSessionReadOnlyReason()).toContain("ownership");
        // The fixture hosts share a JS ownership-guard map; real worker/viewer
        // windows do not. Dispose the stale fixture before observing the owner.
        second.dispose();
        await third.project.saveCurrentProject();
        await third.command.flushHistory();
        const visibleProject = third.project.getActive();
        const visibleScenes = third.editor.scenes.getScenes();
        const visibleAssets = third.editor.media.getAssets();
        const requestsBeforeHandoff = calls.length;
        expect(third.project.observeBatchPreview({id:"classic-project"})).toBe(false);
        setBatchReadOnlyProjects(["classic-project"]);
        expect(third.project.observeBatchPreview({id:"classic-project"})).toBe(true);
        expect(third.project.getIsLoading()).toBe(false);
        expect(third.project.getActive()).toBe(visibleProject);
        expect(third.editor.scenes.getScenes()).toBe(visibleScenes);
        expect(third.editor.media.getAssets()).toBe(visibleAssets);
        expect(calls.length).toBe(requestsBeforeHandoff);
        expect(() => third.command.undo()).toThrow();
        // The fixture hosts share a JS ownership-guard map; real worker/viewer
        // windows do not. Dispose the stale fixture before observing the owner.
        second.dispose();
        await third.project.saveCurrentProject();
        expect(calls.length).toBe(requestsBeforeHandoff);

	} finally {
		first.dispose();
		second.dispose();
		third.dispose();
        setBatchReadOnlyProjects([]);
        acknowledgeAutomationReload({projectId:"classic-project",version:automationReadVersion("classic-project")});
		fetchMock.mockRestore();
		if (originalWindow)
			Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
}, 30_000);
