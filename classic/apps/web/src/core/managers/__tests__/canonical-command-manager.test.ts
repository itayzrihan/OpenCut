/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- host views are minimal test doubles; all document and history operations run through the generated Rust WASM. */
import { beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command, type CommandResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import type { TScene } from "@/timeline/types";
import type {
	EditorSelectionPatch,
	EditorSelectionSnapshot,
} from "@/selection/editor-selection";
import type { SerializedCommandHistory } from "@/services/storage/types";
import {
	canonicalMediaBindings,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "../../__tests__/canonical-runtime-fixture";
import { HyperframesRenderCache } from "@/hyperframes/render-cache";
import { renderFixture } from "@/hyperframes/__tests__/render-client-fixture";
import { parseHTML } from "@/hyperframes/__tests__/layer-move-fixture";
import type {
	HyperframesRuntimeManifest,
	HyperframesSource,
} from "@/hyperframes/types";

let saved: SerializedCommandHistory | null = null;
mock.module("@/services/storage/service", () => ({
	storageService: {
		saveCommandHistory: async ({
			history,
		}: {
			history: SerializedCommandHistory;
		}) => {
			saved = structuredClone(history);
		},
		loadCommandHistory: async () => structuredClone(saved),
	},
}));
mock.module("@/ripple", () => ({
	computeRippleAdjustments: () => {
		throw new Error("Ripple should be disabled");
	},
	applyRippleAdjustments: () => {
		throw new Error("Ripple should be disabled");
	},
}));
mock.module("@/timeline/scenes", () => ({
	getMainScene: ({ scenes }: { scenes: TScene[] }) =>
		scenes.find((scene) => scene.isMain) ?? null,
	ensureMainScene: ({ scenes }: { scenes: TScene[] }) => scenes,
	canDeleteScene: () => ({ canDelete: true }),
	findCurrentScene: ({
		scenes,
		currentSceneId,
	}: {
		scenes: TScene[];
		currentSceneId: string;
	}) => scenes.find((scene) => scene.id === currentSceneId),
	getProjectDurationFromScenes: () => {
		throw new Error("Fixture supplies duration");
	},
}));
mock.module("@/parallax-story-teller/model", () => ({
	restoreParallaxSceneMetadataForScenes: ({ scenes }: { scenes: TScene[] }) =>
		scenes,
}));
mock.module("@/timeline/bookmarks/index", () => ({
	getBookmarkAtTime: () => null,
	getFrameTime: () => 0,
	isBookmarkAtTime: () => false,
}));
mock.module("@/commands/scene", () =>
	Object.fromEntries(
		[
			"CreateSceneCommand",
			"DeleteSceneCommand",
			"MoveBookmarkCommand",
			"RemoveBookmarkCommand",
			"RenameSceneCommand",
			"ToggleBookmarkCommand",
			"UpdateBookmarkCommand",
		].map((name) => [name, class {}]),
	),
);

let CommandManager: typeof import("@/core/managers/commands").CommandManager;
let ScenesManager: typeof import("@/core/managers/scenes-manager").ScenesManager;
beforeAll(async () => {
	({ CommandManager } = await import("@/core/managers/commands"));
	({ ScenesManager } = await import("@/core/managers/scenes-manager"));
});
beforeEach(() => {
	saved = null;
});

function createHost(initial?: { project: TProject; media: MediaAsset[] }) {
	const viewListeners = new Set<() => void>();
	const fixture = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	let project: TProject = initial?.project ?? {
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
	let media: MediaAsset[] = initial?.media ?? fixture.mediaAssets;
	let selection: EditorSelectionSnapshot = {
		selectedElements: [],
		selectedTextWords: [],
		selectedKeyframes: [],
		keyframeSelectionAnchor: null,
		selectedMaskPoints: null,
	};
	const editor = {
		get scenes() {
			return scenes;
		},
		project: {
			getActiveOrNull: () => project,
			getActive: () => project,
			setActiveProject: ({ project: next }: { project: TProject }) => {
				manager.synchronizeProject(next);
				project = next;
				for (const listener of viewListeners) listener();
			},
		},
		media: {
			getAssets: () => media,
			setAssets: ({ assets }: { assets: MediaAsset[] }) => {
				manager.synchronizeMedia({ assets });
				media = assets;
				for (const listener of viewListeners) listener();
			},
		},
		selection: {
			getSnapshot: () => structuredClone(selection),
			restoreSnapshot: ({
				snapshot,
			}: {
				snapshot: EditorSelectionSnapshot;
			}) => {
				selection = structuredClone(snapshot);
			},
			applySelectionPatch: ({ patch }: { patch: EditorSelectionPatch }) => {
				selection = { ...selection, ...patch };
				return structuredClone(selection);
			},
		},
		save: {
			pause: () => undefined,
			resume: () => undefined,
			markDirty: () => undefined,
		},
	} as unknown as EditorCore;
	const manager = new CommandManager(editor);
	const scenes = new ScenesManager(editor);
	editor.scenes.initializeScenes({
		scenes: project.scenes,
		currentSceneId: project.currentSceneId,
	});
	return {
		manager,
		editor,
		project: () => project,
		media: () => media,
		selection: () => selection,
		subscribeViews: (listener: () => void) => {
			viewListeners.add(listener);
			return () => viewListeners.delete(listener);
		},
	};
}

class Rename extends Command {
	private before = "";
	private host: ReturnType<typeof createHost>;
	private name: string;
	private select: boolean;
	constructor({
		host,
		name,
		select = false,
	}: {
		host: ReturnType<typeof createHost>;
		name: string;
		select?: boolean;
	}) {
		super();
		this.host = host;
		this.name = name;
		this.select = select;
	}
	execute(): CommandResult | undefined {
		this.before = this.host.project().metadata.name;
		this.rename(this.name);
		return this.select
			? {
					selection: {
						selectedElements: [{ trackId: "video-track", elementId: "item-2" }],
					},
				}
			: undefined;
	}
	undo() {
		this.rename(this.before);
	}
	private rename(name: string) {
		const project = this.host.project();
		this.host.editor.project.setActiveProject({
			project: { ...project, metadata: { ...project.metadata, name } },
		});
	}
}

const source = {
	entryFile: "index.html",
	files: {
		"index.html":
			"<div data-composition-id='main' data-duration='6'>שלום</div>",
	},
	resourceAssetIds: {},
};

test("source and variable preflight commit through canonical history and survive reopening", async () => {
	const browser = renderFixture();
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	const { HyperframesRenderClient } =
		await import("@/hyperframes/render-client");
	const checkedSources: unknown[] = [];
	const prepare = spyOn(
		HyperframesRenderClient.prototype,
		"prepareSource",
	).mockImplementation(async (prepared) => {
		checkedSources.push(structuredClone(prepared));
		const inspection = runtime.invokeSync(
			"hyperframes.project.inspect",
			{ source: prepared },
			undefined,
		) as { result: { data: { fingerprint: string } } };
		return {
			id: "checked",
			previewUrl: "http://localhost/checked",
			fingerprint: inspection.result.data.fingerprint,
			width: 1920,
			height: 1080,
			durationSeconds: 6,
			runtimeManifest: {
				sourceFingerprint: inspection.result.data.fingerprint,
				runtimeVersion: "0.8.115",
				durationSeconds: 6,
				layers: [],
				diagnostics: [],
			},
		};
	});
	let reopened: ReturnType<typeof createHost> | undefined;
	try {
		await host.manager.enableCanonical({ runtime });
		const originalSource = {
			...source,
			files: { ...source.files, "unused.css": "/* retained */" },
		};
		const imported = await host.manager.importHyperframes({
			name: "Editable",
			source: originalSource,
			importId: "edit-import",
		});
		const before = structuredClone(host.project());
		const html = `<html data-composition-variables='[{"id":"title","type":"string","default":"Original"}]'>${source.files["index.html"].replace("שלום", "Changed")}</html>`;
		const request = {
			projectId: "classic-project",
			sceneId: host.project().currentSceneId,
			elementId: imported.itemId,
			signal: new AbortController().signal,
		};
		await host.manager.setHyperframesSource({
			...request,
			source: originalSource,
			changes: { "index.html": html, "motion.js": "// שלום\r\n" },
		});
		const afterSource = structuredClone(host.project());
		const updatedSource =
			afterSource.hyperframesCompositions![imported.assetId].source;
		expect(updatedSource.files).toEqual({
			"index.html": html,
			"motion.js": "// שלום\r\n",
			"unused.css": "/* retained */",
		});
		expect(checkedSources).toEqual([updatedSource]);
		expect(
			afterSource.hyperframesCompositions![imported.assetId].importId,
		).toBe("edit-import");
		expect(originalSource.files["index.html"]).toBe(source.files["index.html"]);
		await host.manager.setHyperframesVariables({
			...request,
			source: updatedSource,
			values: { title: "Updated variable" },
		});
		const afterVariables = structuredClone(host.project());
		expect(
			afterVariables.hyperframesCompositions![imported.assetId].source
				.variables,
		).toEqual({ title: "Updated variable" });
		expect(checkedSources).toHaveLength(2);
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.project()).toEqual(afterSource);
		host.manager.undo();
		expect(host.project()).toEqual(before);
		host.manager.redo();
		host.manager.redo();
		await host.manager.flushHistory();
		reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		expect(reopened.project()).toEqual(afterVariables);
		reopened.manager.undo();
		expect(reopened.project()).toEqual(afterSource);
		reopened.manager.undo();
		expect(reopened.project()).toEqual(before);
		reopened.manager.redo();
		reopened.manager.redo();
		expect(reopened.project()).toEqual(afterVariables);
	} finally {
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		if (reopened) {
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
		}
		prepare.mockRestore();
		browser.restore();
	}
});

test("source preflight rejects cancellation, account or scene switches, stale revisions and render failures", async () => {
	const browser = renderFixture();
	const { HyperframesRenderClient } =
		await import("@/hyperframes/render-client");
	try {
		for (const failure of [
			"cancel",
			"account",
			"scene",
			"revision",
			"render",
		]) {
			const host = createHost();
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const imported = await host.manager.importHyperframes({
				name: "Editable",
				source,
			});
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const prepare = spyOn(
				HyperframesRenderClient.prototype,
				"prepareSource",
			).mockImplementation(async (prepared) => {
				entered.resolve();
				await resume.promise;
				if (failure === "render") throw new Error("Broken animation");
				const inspection = runtime.invokeSync(
					"hyperframes.project.inspect",
					{ source: prepared },
					undefined,
				) as { result: { data: { fingerprint: string } } };
				return {
					id: "checked",
					previewUrl: "http://localhost/checked",
					fingerprint: inspection.result.data.fingerprint,
					width: 1920,
					height: 1080,
					durationSeconds: 6,
					runtimeManifest: {
						sourceFingerprint: inspection.result.data.fingerprint,
						runtimeVersion: "0.8.115",
						durationSeconds: 6,
						layers: [],
						diagnostics: [],
					},
				};
			});
			const dispose = spyOn(HyperframesRenderClient.prototype, "dispose");
			try {
				const controller = new AbortController();
				const pending = host.manager.setHyperframesSource({
					projectId: "classic-project",
					sceneId: host.project().currentSceneId,
					elementId: imported.itemId,
					source,
					changes: {
						"index.html": source.files["index.html"].replace("שלום", "Changed"),
					},
					signal: controller.signal,
				});
				await entered.promise;
				if (failure === "cancel") controller.abort();
				if (failure === "account")
					browser.browser.__opencutAccountId = "account-b";
				if (failure === "scene")
					host.editor.scenes.initializeScenes({
						scenes: host.project().scenes,
						currentSceneId: host.project().scenes[1].id,
					});
				if (failure === "revision")
					host.manager.execute({
						command: new Rename({ host, name: "Concurrent rename" }),
					});
				const before = structuredClone(host.project());
				resume.resolve();
				await expect(pending).rejects.toThrow();
				expect(host.project()).toEqual(before);
				expect(
					host.project().hyperframesCompositions![imported.assetId].source,
				).toEqual(source);
				expect(dispose).toHaveBeenCalled();
			} finally {
				await host.manager.flushHistory();
				host.manager.detachCanonical();
				prepare.mockRestore();
				dispose.mockRestore();
				browser.browser.__opencutAccountId = "account-a";
			}
		}
	} finally {
		browser.restore();
	}
});

test("layer move compiles source and commits history, while cancellation and concurrent edits discard preflight", async () => {
	const browser = renderFixture();
	const savedParser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
	Object.defineProperty(globalThis, "DOMParser", {
		configurable: true,
		value: class {
			parseFromString(html: string) {
				return parseHTML(html).document;
			}
		},
	});
	const { HyperframesRenderClient } =
		await import("@/hyperframes/render-client");
	try {
		for (const outcome of ["commit", "cancel", "revision"]) {
			const host = createHost();
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const source: HyperframesSource = {
				entryFile: "index.html",
				resourceAssetIds: {},
				files: {
					"index.html": `<div data-composition-id="main" data-width="320" data-height="180" data-duration="6"><div id="paint" data-start="1" data-duration="2"></div></div><script>const tl=gsap.timeline({paused:true});tl.to('#paint',{x:100,duration:2},1);window.__timelines={main:tl};</script>`,
				},
			};
			const manifestFor = (
				prepared: HyperframesSource,
			): HyperframesRuntimeManifest => {
				const inspection = runtime.invokeSync(
					"hyperframes.project.inspect",
					{ source: prepared },
					undefined,
				) as { result: { data: { fingerprint: string } } };
				return {
					sourceFingerprint: inspection.result.data.fingerprint,
					runtimeVersion: "0.8.115",
					durationSeconds: 6,
					diagnostics: [],
					layers: [
						{
							key: "dom/1/0/0",
							parentKey: null,
							file: "index.html",
							elementId: "paint",
							label: "paint",
							kind: "element",
							startSeconds: Number(
								parseHTML(prepared.files["index.html"])
									.document.getElementById("paint")!
									.getAttribute("data-start"),
							),
							durationSeconds: 2,
							trackIndex: 0,
							resourcePath: null,
							playbackStartSeconds: 0,
							playbackRate: 1,
							media: null,
						},
					],
				};
			};
			const manifest = manifestFor(source);
			const imported = await host.manager.importHyperframes({
				name: "Layer move",
				source,
				runtimeManifest: manifest,
			});
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const checked: HyperframesSource[] = [];
			const prepare = spyOn(
				HyperframesRenderClient.prototype,
				"prepareSource",
			).mockImplementation(async (prepared) => {
				checked.push(structuredClone(prepared));
				entered.resolve();
				await resume.promise;
				const runtimeManifest = manifestFor(prepared);
				return {
					id: "checked",
					previewUrl: "http://localhost/checked",
					fingerprint: runtimeManifest.sourceFingerprint,
					width: 320,
					height: 180,
					durationSeconds: 6,
					runtimeManifest,
				};
			});
			const dispose = spyOn(HyperframesRenderClient.prototype, "dispose");
			try {
				const before = structuredClone(host.project());
				const controller = new AbortController();
				const pending = host.manager.moveHyperframesLayer({
					projectId: "classic-project",
					sceneId: before.currentSceneId,
					elementId: imported.itemId,
					source,
					manifest,
					layerKey: manifest.layers[0].key,
					startSeconds: 3,
					signal: controller.signal,
				});
				await Promise.race([entered.promise, pending]);
				expect(checked).toHaveLength(1);
				expect(checked[0].files["index.html"]).toContain("duration:2},3)");
				expect(host.project()).toEqual(before);
				if (outcome === "cancel") controller.abort();
				if (outcome === "revision")
					host.manager.execute({
						command: new Rename({ host, name: "Concurrent rename" }),
					});
				const current = structuredClone(host.project());
				resume.resolve();
				if (outcome === "commit") {
					await pending;
					const after = structuredClone(host.project());
					expect(
						after.hyperframesCompositions![imported.assetId].source,
					).toEqual(checked[0]);
					expect(
						after.hyperframesCompositions![imported.assetId].runtimeManifest!
							.layers[0].startSeconds,
					).toBe(3);
					assertCoherent({ host, runtime });
					host.manager.undo();
					expect(host.project()).toEqual(before);
					host.manager.redo();
					expect(host.project()).toEqual(after);
				} else {
					await expect(pending).rejects.toThrow();
					expect(host.project()).toEqual(current);
				}
				expect(dispose).toHaveBeenCalled();
			} finally {
				resume.resolve();
				await host.manager.flushHistory();
				host.manager.detachCanonical();
				prepare.mockRestore();
				dispose.mockRestore();
			}
		}
	} finally {
		if (savedParser)
			Object.defineProperty(globalThis, "DOMParser", savedParser);
		else Reflect.deleteProperty(globalThis, "DOMParser");
		browser.restore();
	}
});

test("composition library reuses its canonical source with selection and persistent undo", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	const imported = await host.manager.importHyperframes({
		name: "Brag",
		source,
	});
	const projectId = host.project().metadata.id;
	const before = host.manager.captureProjectSnapshot();
	const mediaBefore = structuredClone(host.media());
	const library = await host.manager.readHyperframesLibrary({ projectId });
	expect(library.items).toHaveLength(1);
	expect(library.items[0]).toMatchObject({
		assetId: imported.assetId,
		name: "Brag",
		sourceFileCount: 1,
		durationSeconds: 6,
	});
	expect(host.manager.captureProjectSnapshot()).toEqual(before);
	const inserted = await host.manager.insertHyperframes({
		projectId,
		sceneId: host.project().currentSceneId,
		assetId: imported.assetId,
		name: "Brag again",
		startSeconds: 2.5,
	});
	expect(inserted.assetId).toBe(imported.assetId);
	expect(inserted.itemId).not.toBe(imported.itemId);
	expect(host.project().hyperframesCompositions).toEqual(
		before!.hyperframesCompositions,
	);
	expect(host.media()).toEqual(mediaBefore);
	expect(host.selection().selectedElements).toEqual([
		{ trackId: inserted.trackId, elementId: inserted.itemId },
	]);
	const after = host.manager.captureProjectSnapshot();
	const reused = await host.manager.readHyperframesLibrary({ projectId });
	expect(reused.items[0].occurrences).toHaveLength(2);
	expect(
		reused.items[0].occurrences.find(
			(item) => item.elementId === inserted.itemId,
		)?.startTime,
	).toBe(300000);
	assertCoherent({ host, runtime });
	host.manager.undo();
	expect(host.manager.captureProjectSnapshot()).toEqual(before);
	host.manager.redo();
	expect(host.manager.captureProjectSnapshot()).toEqual(after);
	await expect(
		host.manager.readHyperframesLibrary({ projectId: "other" }),
	).rejects.toThrow("project changed");
	await expect(
		host.manager.insertHyperframes({
			projectId,
			sceneId: "other",
			assetId: imported.assetId,
			name: "Wrong scene",
		}),
	).rejects.toThrow("scene changed");
	expect(host.manager.captureProjectSnapshot()).toEqual(after);
	await host.manager.flushHistory();
	expect(saved).not.toBeNull();
	host.manager.detachCanonical();
	const reopened = createHost({
		project: structuredClone(host.project()),
		media: host.media(),
	});
	await reopened.manager.loadHistory({ projectId });
	await reopened.manager.enableCanonical({
		runtime: await createCanonicalTestRuntime(),
	});
	expect(
		(await reopened.manager.readHyperframesLibrary({ projectId })).items[0]
			.occurrences,
	).toHaveLength(2);
	reopened.manager.undo();
	expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
	await reopened.manager.flushHistory();
	reopened.manager.detachCanonical();
});

test("audio projection reads the same canonical clip after host edits and undo", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	const imported = await host.manager.importHyperframes({
		name: "Narration",
		source,
		startSeconds: 8,
	});
	const input = {
		projectId: host.project().metadata.id,
		sceneId: host.project().currentSceneId,
	};
	const before = await host.manager.readHyperframesAudioClips(input);
	expect(before.clips[0].compositionId).toBe(imported.assetId);
	expect(Number(before.clips[0].element.startTime)).toBe(960000);
	const snapshot = host.manager.captureProjectSnapshot();
	host.manager.executeTransaction({
		execute: () => {
			const project = structuredClone(host.project());
			const scene = project.scenes.find((scene) => scene.id === input.sceneId)!;
			const track = scene.tracks.overlay.find(
				(track) => track.id === imported.trackId,
			)!;
			const element = track.elements.find(
				(element) => element.id === imported.itemId,
			)!;
			Object.assign(element, {
				startTime: 240000,
				trimStart: 120000,
				duration: 360000,
				trimEnd: 240000,
			});
			host.editor.scenes.updateSceneTracks({ tracks: scene.tracks });
		},
	});
	const changed = await host.manager.readHyperframesAudioClips(input);
	expect(changed.clips[0].element).toMatchObject({
		startTime: 240000,
		trimStart: 120000,
		duration: 360000,
		trimEnd: 240000,
	});
	assertCoherent({ host, runtime });
	host.manager.undo();
	expect(host.manager.captureProjectSnapshot()).toEqual(snapshot);
	expect((await host.manager.readHyperframesAudioClips(input)).clips).toEqual(
		before.clips,
	);
	host.manager.redo();
	expect((await host.manager.readHyperframesAudioClips(input)).clips).toEqual(
		changed.clips,
	);
	await expect(
		host.manager.readHyperframesAudioClips({ ...input, projectId: "other" }),
	).rejects.toThrow("project changed");
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("runtime layers publish through canonical state, undo and persisted history", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	const imported = await host.manager.importHyperframes({
		name: "Layers",
		source,
	});
	const inspection = runtime.invokeSync(
		"hyperframes.project.inspect",
		{ source },
		undefined,
	) as { result: { data: { fingerprint: string } } };
	const manifest = {
		sourceFingerprint: inspection.result.data.fingerprint,
		runtimeVersion: "0.8.115",
		durationSeconds: 6,
		layers: [
			{
				key: "generated/title",
				parentKey: null,
				file: "index.html",
				elementId: null,
				label: "Generated title",
				kind: "element" as const,
				startSeconds: 1.5,
				durationSeconds: 2,
				trackIndex: 1,
				resourcePath: null,
				playbackStartSeconds: 0,
				playbackRate: 1,
				media: null,
			},
		],
		diagnostics: [],
	};
	const request = {
		projectId: "classic-project",
		assetId: imported.assetId,
		manifest,
	};
	const before = structuredClone(host.project());
	await expect(
		host.manager.setHyperframesManifest({
			...request,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow();
	await expect(
		host.manager.setHyperframesManifest({ ...request, projectId: "other" }),
	).rejects.toThrow();
	await expect(
		host.manager.setHyperframesManifest({
			...request,
			manifest: { ...manifest, sourceFingerprint: "stale" },
		}),
	).rejects.toThrow();
	expect(host.project()).toEqual(before);
	await host.manager.setHyperframesManifest(request);
	const layerRows = await host.manager.readHyperframesLayerRows({
		projectId: "classic-project",
		sceneId: host.editor.scenes.getActiveScene().id,
		elementId: imported.itemId,
	});
	expect(layerRows.clip.rows).toHaveLength(1);
	expect(layerRows.clip.rows[0]).toMatchObject({
		key: "generated/title",
		label: "Generated title",
		duration: 240_000,
		depth: 0,
	});
	await expect(
		host.manager.readHyperframesLayerRows({
			projectId: "other",
			sceneId: host.editor.scenes.getActiveScene().id,
			elementId: imported.itemId,
		}),
	).rejects.toThrow();
	expect(
		host.project().hyperframesCompositions?.[imported.assetId].runtimeManifest,
	).toEqual(manifest);
	assertCoherent({ host, runtime });
	host.manager.undo();
	expect(
		host.project().hyperframesCompositions?.[imported.assetId].runtimeManifest,
	).toBeUndefined();
	host.manager.redo();
	expect(
		host.project().hyperframesCompositions?.[imported.assetId].runtimeManifest,
	).toEqual(manifest);
	await host.manager.flushHistory();
	const reloaded = createHost({
		project: structuredClone(host.project()),
		media: host.media(),
	});
	const reopenedRuntime = await createCanonicalTestRuntime();
	await reloaded.manager.loadHistory({ projectId: "classic-project" });
	await reloaded.manager.enableCanonical({ runtime: reopenedRuntime });
	reloaded.manager.undo();
	expect(
		reloaded.project().hyperframesCompositions?.[imported.assetId]
			.runtimeManifest,
	).toBeUndefined();
	reloaded.manager.redo();
	expect(
		reloaded.project().hyperframesCompositions?.[imported.assetId]
			.runtimeManifest,
	).toEqual(manifest);
	assertCoherent({ host: reloaded, runtime: reopenedRuntime });
	await reloaded.manager.flushHistory();
	host.manager.detachCanonical();
	reloaded.manager.detachCanonical();
});

function assertCoherent({
	host,
	runtime,
}: {
	host: ReturnType<typeof createHost>;
	runtime: Awaited<ReturnType<typeof createCanonicalTestRuntime>>;
}) {
	const state = runtime.snapshot() as {
		project: { classic: CanonicalClassicSnapshot };
	};
	expect(state.project.classic.document).toEqual(
		host.manager.captureProjectSnapshot()!,
	);
	expect(state.project.classic.mediaAssets).toEqual(
		canonicalMediaBindings(host.media()),
	);
}

test("real canonical edits and undo/redo reuse HyperFrames browsers and decoded frames", async () => {
	const fixture = renderFixture();
	const cache = new HyperframesRenderCache();
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	const refresh = () =>
		cache.update({ project: host.project(), mediaAssets: host.media() });
	const unsubscribe = host.subscribeViews(refresh);
	try {
		await host.manager.enableCanonical({ runtime });
		const imported = await host.manager.importHyperframes({
			name: "Cached overlay",
			source: {
				...source,
				resourceAssetIds: { "media.mp4": host.media()[0].id },
			},
		});
		refresh();
		const draw = () => {
			const context = cache.getContext(host.project())!;
			return context.renderTo({
				composition: context.compositions[imported.assetId],
				timeSeconds: 1,
				target: fixture.target,
			});
		};
		await draw();
		const revision = cache.revision;
		const initialMedia = host.media();
		for (let edit = 0; edit < 20; edit++) {
			host.manager.execute({
				command: new Rename({ host, name: `Edit ${edit}` }),
			});
			await draw();
		}
		host.manager.undo();
		await draw();
		host.manager.redo();
		await draw();
		expect(host.media()).not.toBe(initialMedia);
		expect(cache.revision).toBe(revision);
		expect(fixture.count("open")).toBe(1);
		expect(fixture.count("capture")).toBe(1);
		expect(fixture.count("close")).toBe(0);
		assertCoherent({ host, runtime });
	} finally {
		unsubscribe();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		cache.dispose();
		fixture.restore();
	}
});

test("adopts live Classic undo, imports into existing scenes and retains selective command behavior", async () => {
	const host = createHost();
	const originalScenes = structuredClone(host.project().scenes);
	host.manager.execute({ command: new Rename({ host, name: "Renamed" }) });
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	assertCoherent({ host, runtime });
	const imported = await host.manager.importHyperframes({
		name: "Overlay",
		source,
	});
	expect(host.project().scenes).toHaveLength(2);
	expect(host.project().scenes[0].tracks.main).toEqual(
		originalScenes[0].tracks.main,
	);
	expect(host.project().scenes[1]).toEqual(originalScenes[1]);
	expect(
		host.project().hyperframesCompositions?.[imported.assetId].source,
	).toEqual(source);
	assertCoherent({ host, runtime });
	host.manager.undo();
	expect(host.project().scenes).toEqual(originalScenes);
	const addedFont = {
		...host.project().customFonts![0],
		id: "font-after-import",
	};
	host.editor.project.setActiveProject({
		project: {
			...host.project(),
			customFonts: [...host.project().customFonts!, addedFont],
		},
	});
	host.manager.undo();
	expect(host.project().metadata.name).toBe("Existing edit");
	expect(host.project().customFonts).toContainEqual(addedFont);
	assertCoherent({ host, runtime });
	host.manager.redo();
	expect(host.project().metadata.name).toBe("Renamed");
	expect(host.project().customFonts).toContainEqual(addedFont);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("scene views publish after validation and keep a valid active scene after deletion", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	const before = host.editor.scenes.getScenes();
	let notifications = 0;
	host.editor.scenes.subscribe(() => {
		notifications += 1;
		assertCoherent({ host, runtime });
	});
	expect(() =>
		host.editor.scenes.setScenes({ scenes: [...before, before[0]] }),
	).toThrow();
	expect(host.editor.scenes.getScenes()).toBe(before);
	expect(notifications).toBe(0);
	const active = host.editor.scenes.getActiveScene();
	expect(() =>
		host.editor.scenes.updateSceneTracks({
			tracks: {
				...active.tracks,
				main: { ...active.tracks.main, id: "titles" },
			},
		}),
	).toThrow();
	expect(host.editor.scenes.getActiveScene()).toBe(active);
	expect(notifications).toBe(0);
	await host.editor.scenes.switchToScene({ sceneId: "other-scene" });
	host.editor.scenes.setScenes({ scenes: [before[0]] });
	expect(host.project().currentSceneId).toBe("main-scene");
	expect(host.editor.scenes.getActiveScene().id).toBe("main-scene");
	expect(notifications).toBe(2);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("folder import preflights bindings and retains durable resource URLs through undo/redo", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	const before = runtime.snapshot();
	const input = {
		name: "Folder",
		source: { ...source, resourceAssetIds: { "font.woff2": "folder-font" } },
		classicResourceAssets: [
			{
				id: "folder-font",
				name: "font.woff2",
				type: "file" as const,
				storageKind: "copied" as const,
				mimeType: "font/woff2",
				size: 12,
				lastModified: 1,
			},
		],
		target: {
			projectId: host.project().metadata.id,
			sceneId: host.editor.scenes.getActiveScene().id,
		},
	};
	await host.manager.importHyperframes({ ...input, dryRun: true });
	expect(runtime.snapshot()).toEqual(before);
	await expect(
		host.manager.importHyperframes({
			...input,
			target: { ...input.target, sceneId: "another-scene" },
		}),
	).rejects.toThrow("scene changed");
	await expect(
		host.manager.importHyperframes({
			...input,
			target: { ...input.target, signal: AbortSignal.abort() },
		}),
	).rejects.toThrow();
	expect(runtime.snapshot()).toEqual(before);
	const imported = await host.manager.importHyperframes(input);
	const resource = host.media().find(({ id }) => id === "folder-font");
	expect(resource?.url).toContain("id=folder-font");
	expect(
		host.project().hyperframesCompositions?.[imported.assetId],
	).toBeDefined();
	host.manager.undo();
	expect(
		host.project().hyperframesCompositions?.[imported.assetId],
	).toBeUndefined();
	// Like ordinary media import, durable files remain in the library for redo.
	expect(host.media().find(({ id }) => id === "folder-font")?.url).toBe(
		resource?.url,
	);
	host.manager.redo();
	expect(
		host.project().hyperframesCompositions?.[imported.assetId],
	).toBeDefined();
	expect(host.media().find(({ id }) => id === "folder-font")?.url).toBe(
		resource?.url,
	);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("redo retains current selection as its next undo target", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	host.manager.execute({
		command: new Rename({ host, name: "Selected edit", select: true }),
	});
	host.manager.undo();
	expect(host.selection().selectedElements).toEqual([]);
	const click = { trackId: "titles", elementId: "text-1" };
	host.editor.selection.applySelectionPatch({
		patch: { selectedElements: [click] },
	});
	host.manager.redo();
	expect(host.selection().selectedElements[0].elementId).toBe("item-2");
	host.manager.undo();
	expect(host.selection().selectedElements).toEqual([click]);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("nested commands form one undo step and retain preview ripple and reactor options", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	let reactorCalls = 0;
	host.manager.registerReactor(() => {
		reactorCalls += 1;
	});
	const first = new Rename({ host, name: "First" });
	const second = new Rename({ host, name: "Second" });
	class Nested extends Command {
		execute(): undefined {
			host.manager.execute({
				command: first,
				applyRipple: false,
				runReactors: false,
			});
			host.manager.execute({
				command: second,
				applyRipple: false,
				runReactors: false,
			});
		}
		undo() {
			second.undo();
			first.undo();
		}
	}
	host.manager.execute({
		command: new Nested(),
		applyRipple: false,
		runReactors: false,
	});
	expect(host.project().metadata.name).toBe("Second");
	host.manager.undo();
	expect(host.project().metadata.name).toBe("Existing edit");
	expect(host.manager.canUndo()).toBe(false);
	host.manager.redo();
	expect(host.project().metadata.name).toBe("Second");
	expect(reactorCalls).toBe(0);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	expect(saved!.canonicalArchive!.undoStack).toHaveLength(1);
	host.manager.detachCanonical();
});

test("validation failure rolls back earlier changes and preserves redo", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	await host.manager.importHyperframes({ name: "Source", source });
	host.manager.undo();
	const before = host.manager.captureProjectSnapshot();
	expect(() =>
		host.manager.executeTransaction({
			execute: () => {
				host.manager.execute({
					command: new Rename({ host, name: "Partial edit" }),
				});
				host.editor.project.setActiveProject({
					project: { ...host.project(), currentSceneId: "missing-scene" },
				});
			},
		}),
	).toThrow();
	expect(host.manager.captureProjectSnapshot()).toEqual(before);
	expect(host.manager.canUndo()).toBe(false);
	expect(host.manager.canRedo()).toBe(true);
	assertCoherent({ host, runtime });
	host.manager.redo();
	expect(
		Object.keys(host.project().hyperframesCompositions ?? {}),
	).toHaveLength(1);
	assertCoherent({ host, runtime });
	await host.manager.flushHistory();
	host.manager.detachCanonical();
});

test("media callbacks and handles survive live history; compact persisted history reopens", async () => {
	const host = createHost();
	const runtime = await createCanonicalTestRuntime();
	await host.manager.enableCanonical({ runtime });
	await host.manager.importHyperframes({ name: "Source", source });
	const file = new File(["pixels"], "image.png", { lastModified: 1 });
	const asset: MediaAsset = {
		id: "added-image",
		name: "Image",
		type: "image",
		file,
		url: "blob:retained",
	};
	let saves = 0;
	let deletes = 0;
	class AddMedia extends Command {
		override get canPersistHistory() {
			return false;
		}
		execute(): undefined {
			saves += 1;
			host.editor.media.setAssets({ assets: [...host.media(), asset] });
		}
		undo() {
			deletes += 1;
			host.editor.media.setAssets({
				assets: host.media().filter((media) => media.id !== asset.id),
			});
		}
	}
	host.manager.executeTransaction({
		execute: () => {
			host.manager.execute({ command: new AddMedia() });
			host.manager.execute({
				command: new Rename({ host, name: "Added media" }),
			});
		},
	});
	host.manager.undo();
	expect(deletes).toBe(1);
	expect(host.media()).toHaveLength(1);
	expect(host.project().metadata.name).toBe("Existing edit");
	host.manager.redo();
	expect(saves).toBe(2);
	expect(host.media().find((media) => media.id === asset.id)?.file).toBe(file);
	expect(host.project().metadata.name).toBe("Added media");
	assertCoherent({ host, runtime });
	host.manager.execute({ command: new Rename({ host, name: "After media" }) });
	await host.manager.flushHistory();
	expect(saved!.schemaVersion).toBe(2);
	expect(saved!.canonicalArchive!.undoStack).toHaveLength(1);
	expect(Object.keys(saved!.canonicalArchive!.sources)).toHaveLength(1);
	expect(JSON.stringify(saved)).not.toContain("blob:retained");
	const reloaded = createHost({
		project: structuredClone(host.project()),
		media: host.media(),
	});
	const reopenedRuntime = await createCanonicalTestRuntime();
	await reloaded.manager.loadHistory({ projectId: "classic-project" });
	await reloaded.manager.enableCanonical({ runtime: reopenedRuntime });
	reloaded.manager.undo();
	expect(reloaded.project().metadata.name).toBe("Added media");
	expect(reloaded.manager.canUndo()).toBe(false);
	expect(reloaded.media().find((media) => media.id === asset.id)?.file).toBe(
		file,
	);
	reloaded.manager.redo();
	expect(reloaded.project().metadata.name).toBe("After media");
	expect(reloaded.project().hyperframesCompositions).toEqual(
		host.project().hyperframesCompositions,
	);
	assertCoherent({ host: reloaded, runtime: reopenedRuntime });
	await reloaded.manager.flushHistory();
	host.manager.detachCanonical();
	reloaded.manager.detachCanonical();
});
