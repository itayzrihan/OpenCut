import { mockFetch } from "@/test-support/mock-fetch";
// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- host views are minimal test doubles; all document and history operations run through the generated Rust WASM. */
import { beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Command, type CommandResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import type { TScene, TrackType, TimelineElement } from "@/timeline/types";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { getDefaultInsertIndexForTrack } from "@/timeline/placement/insert-index";
import { splitTrackByType, withReorderedTrack } from "@/timeline/track-order";
import { pruneEmptyElementTracks } from "@/timeline/prune-empty-tracks";
import { buildSeparatedAudioElement } from "./legacy-source-audio-fixture";
import { getClipAudioTiming } from "@/media/audio-sync";
import { insertPointOnFreeformSegment } from "@/masks/__tests__/legacy-freeform-insert";
import type { FreeformPathMask } from "@/masks/types";
import {
	cloneAnimations,
	retimeElementKeyframe,
	updateScalarKeyframeCurve,
} from "@/animation/keyframes";
import type { ClassicKeyframeEdit } from "@/core/canonical-classic-session";
import type {
	ElementAnimations,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import { masksRegistry, buildDefaultMaskInstance } from "@/masks";
import { resolveTrackPlacement } from "@/timeline/placement/resolve";
import {
	buildDefaultEffectInstance,
	effectsRegistry,
	registerDefaultEffects,
} from "@/effects";
import type { VideoElement, AudioElement } from "@/timeline/types";
import {
	getFrameTime,
	toggleBookmarkInArray,
	updateBookmarkInArray,
	moveBookmarkInArray,
	removeBookmarkFromArray,
} from "@/timeline/bookmarks/utils";
import { mediaTime } from "@/wasm/media-time";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import type {
	EditorSelectionPatch,
	EditorSelectionSnapshot,
} from "@/selection/editor-selection";
import type {
	SerializedCommandHistory,
	SerializedProjectHistorySnapshot,
} from "@/services/storage/types";
import {
	canonicalMediaBindings,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { createCanonicalTestRuntime } from "../../__tests__/canonical-runtime-fixture";
import type { EditorSessionBundle } from "@/editor-agent/session-client";
import { HyperframesRenderCache } from "@/hyperframes/render-cache";
import { renderFixture } from "@/hyperframes/__tests__/render-client-fixture";
import { parseHTML } from "@/hyperframes/__tests__/layer-move-fixture";
import type {
	HyperframesRuntimeManifest,
	HyperframesSource,
} from "@/hyperframes/types";

// Real-WASM cases open multiple editor sessions and run complete history/agent
// flows. Use one bounded integration budget; the isolated runner separately
// caps this suite at 480 seconds. These timeouts are not performance assertions.
const INTEGRATION_TIMEOUT = 60_000;
let saved: SerializedCommandHistory | null = null;
// Managers below receive the explicit fixture host. Do not initialize the
// browser singleton through legacy command imports in this integration suite.
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => {
			throw new Error("Use the explicit integration host");
		},
	},
}));
function knowledgeFixtureResponse() {
	return Response.json({
		revision: 7,
		changed: false,
		data: {
			revision: 7,
			skills: [],
			selectedSkills: [],
			memories: [
				{
					key: { kind: "memory", id: "title-style" },
					location: { type: "project", projectId: "classic-project" },
					versions: [
						{
							version: 1,
							storeRevision: 7,
							savedAtMs: 1,
							content: {
								title: "Title style",
								body: "Keep titles short",
								tags: [],
								enabled: true,
							},
							deleted: false,
						},
					],
				},
			],
		},
	});
}
let saveImportedMedia = async (_input: {
	projectId: string;
	mediaAsset: MediaAsset;
}) => {};
mock.module("@/services/storage/service", () => ({
	storageService: {
		saveMediaAsset: (input: { projectId: string; mediaAsset: MediaAsset }) =>
			saveImportedMedia(input),
		isQuotaExceededError: () => false,
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
	PARALLAX_CAMERA_GUIDE_KIND: "parallax-camera-guide",
}));
mock.module("@/timeline/bookmarks/index", () => ({
	getBookmarkAtTime: () => null,
	getFrameTime: () => 0,
	isBookmarkAtTime: () => false,
}));

let CommandManager: typeof import("@/core/managers/commands").CommandManager;
let ScenesManager: typeof import("@/core/managers/scenes-manager").ScenesManager;
beforeAll(async () => {
	({ CommandManager } = await import("@/core/managers/commands"));
	({ ScenesManager } = await import("@/core/managers/scenes-manager"));
});
beforeEach(() => {
	saved = null;
	saveImportedMedia = async () => {};
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
		get command() {
			return manager;
		},
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

test(
	"media import publishes only after saved bytes and keeps canonical FPS/resources through history",
	async () => {
		const { MediaManager } = await import("@/core/managers/media-manager");
		const host = createHost();
		let bundle: EditorSessionBundle | null = null;
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({
			runtime,
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		const before = host.manager.captureProjectSnapshot();
		const beforeMedia = canonicalMediaBindings(host.media());
		const importer = new MediaManager(host.editor);
		const file = new File([new Uint8Array([1, 2, 3])], "import.mp4", {
			type: "video/mp4",
		});
		const asset: MediaAsset = {
			id: "import-native",
			name: "Imported",
			type: "video",
			fps: 59.94,
			duration: 3,
			file,
			url: "blob:import-native",
			storageKind: "copied",
		};
		let finishSave: (() => void) | undefined;
		saveImportedMedia = async () => {
			expect(canonicalMediaBindings(host.media())).toEqual(beforeMedia);
			await new Promise<void>((resolve) => {
				finishSave = resolve;
			});
		};
		const pending = importer.addMediaAsset({
			projectId: "classic-project",
			asset,
		});
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		finishSave!();
		expect(await pending).toEqual(asset);
		expect(host.media().at(-1)?.file).toBe(file);
		expect(host.project().settings.fps).toEqual({
			numerator: 60000,
			denominator: 1001,
		});
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(canonicalMediaBindings(host.media())).toEqual(beforeMedia);
		host.manager.redo();
		expect(host.media().at(-1)?.file).toBe(file);
		expect(host.media().at(-1)?.url).toBe(asset.url);
		await host.manager.persistEditingSession();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(canonicalMediaBindings(reopened.media())).toEqual(beforeMedia);
		reopened.manager.redo();
		expect(reopened.media().at(-1)?.file).toBe(file);
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"failed, stale or detached media import leaves project membership and FPS unchanged",
	async () => {
		const { MediaManager } = await import("@/core/managers/media-manager");
		const host = createHost();
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const importer = new MediaManager(host.editor);
		const asset: MediaAsset = {
			id: "import-stale",
			name: "Imported",
			type: "video",
			fps: 60,
			file: new File(["x"], "import.mp4"),
		};
		const before = host.manager.captureProjectSnapshot();
		const beforeMedia = canonicalMediaBindings(host.media());
		saveImportedMedia = async () => {
			throw new Error("storage unavailable");
		};
		expect(
			await importer.addMediaAsset({ projectId: "classic-project", asset }),
		).toBeNull();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(canonicalMediaBindings(host.media())).toEqual(beforeMedia);
		let finishSave: (() => void) | undefined;
		saveImportedMedia = async () => {
			await new Promise<void>((resolve) => {
				finishSave = resolve;
			});
		};
		const stale = importer.addMediaAsset({
			projectId: "classic-project",
			asset,
		});
		host.manager.registerClassicMedia({
			projectId: "classic-project",
			assets: [{ id: "other", name: "Other", type: "image" }],
			expectedRevision: host.manager.getCanonicalRevision()!,
		});
		const afterConcurrent = host.manager.captureProjectSnapshot();
		finishSave!();
		expect(await stale).toBeNull();
		expect(host.manager.captureProjectSnapshot()).toEqual(afterConcurrent);
		expect(host.media().map((asset) => asset.id)).not.toContain(asset.id);
		const detached = importer.addMediaAsset({
			projectId: "classic-project",
			asset,
		});
		host.manager.detachCanonical();
		finishSave!();
		expect(await detached).toBeNull();
		expect(host.media().map((asset) => asset.id)).not.toContain(asset.id);
	},
	INTEGRATION_TIMEOUT,
);

test(
	"import plus canonical insertion is one undo and a failed insertion rolls back membership and FPS",
	async () => {
		const { MediaManager } = await import("@/core/managers/media-manager");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const importer = new MediaManager(host.editor);
		const before = host.manager.captureProjectSnapshot();
		const beforeMedia = canonicalMediaBindings(host.media());
		const asset: MediaAsset = {
			id: "pasted-file",
			name: "Pasted",
			type: "video",
			fps: 60,
			duration: 1,
			file: new File(["x"], "paste.mp4"),
			url: "blob:pasted-file",
		};
		const afterRegister = (registered: MediaAsset): undefined => {
			host.manager.insertClassicTimelineElements([
				{
					element: {
						type: "video",
						name: "Pasted",
						mediaId: registered.id,
						startTime: mediaTime({ ticks: 600000 }),
						duration: mediaTime({ ticks: 120000 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						params: {},
					},
					placement: { mode: "auto", trackType: "video" },
				},
			]);
		};
		expect(
			await importer.addMediaAsset({
				projectId: "classic-project",
				asset,
				afterRegister,
			}),
		).not.toBeNull();
		const after = host.manager.captureProjectSnapshot();
		expect(host.media().at(-1)?.id).toBe(asset.id);
		expect(host.project().settings.fps).toEqual({
			numerator: 60,
			denominator: 1,
		});
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(canonicalMediaBindings(host.media())).toEqual(beforeMedia);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		host.manager.undo();
		expect(
			await importer.addMediaAsset({
				projectId: "classic-project",
				asset: { ...asset, id: "pasted-failure" },
				afterRegister: () => {
					throw new Error("Follow-up insertion rejected");
				},
			}),
		).toBeNull();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(canonicalMediaBindings(host.media())).toEqual(beforeMedia);
		// A failed follow-up does not consume the prior successful transaction's Redo.
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"history subscribers see committed Undo and Redo availability",
	async () => {
		const host = createHost();
		const availability: boolean[][] = [];
		const unsubscribe = host.manager.subscribeHistory(() => {
			availability.push([host.manager.canUndo(), host.manager.canRedo()]);
		});
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			persistInitial: false,
		});
		try {
			expect(availability.at(-1)).toEqual([false, false]);
			const sceneId = host.project().scenes[0].id;
			host.manager.editClassicScene({
				type: "rename",
				sceneId,
				name: "Edited",
			});
			expect(availability.at(-1)).toEqual([true, false]);
			host.manager.undo();
			expect(availability.at(-1)).toEqual([false, true]);
			host.manager.redo();
			expect(availability.at(-1)).toEqual([true, false]);
			expect(host.project().scenes[0].name).toBe("Edited");
			host.manager.undo();
			host.manager.editClassicScene({
				type: "rename",
				sceneId,
				name: "New edit",
			});
			expect(availability.at(-1)).toEqual([true, false]);
			host.manager.clear({ persist: false });
			expect(availability.at(-1)).toEqual([false, false]);
			unsubscribe();
			const notificationCount = availability.length;
			host.manager.editClassicScene({
				type: "rename",
				sceneId,
				name: "Unsubscribed",
			});
			expect(host.manager.canUndo()).toBe(true);
			expect(availability).toHaveLength(notificationCount);
		} finally {
			unsubscribe();
			host.manager.detachCanonical();
			await host.manager.flushHistory();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"media removal uses one canonical transaction across scenes and reopens with durable Undo handles",
	async () => {
		const { MediaManager } = await import("@/core/managers/media-manager");
		const host = createHost();
		const file = new File([new Uint8Array([1, 2, 3])], "fixture.mp4", {
			type: "video/mp4",
		});
		const original = { ...host.media()[0], file, url: "blob:owned-test-video" };
		host.editor.media.setAssets({ assets: [original] });
		host.project().scenes[1].tracks.main.elements.push({
			id: "other-media-usage",
			name: "Other usage",
			type: "video",
			mediaId: original.id,
			startTime: mediaTime({ ticks: 0 }),
			duration: mediaTime({ ticks: 120000 }),
			trimStart: mediaTime({ ticks: 0 }),
			trimEnd: mediaTime({ ticks: 0 }),
			params: {},
		} as VideoElement);
		let bundle: EditorSessionBundle | null = null;
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({
			runtime,
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		const before = host.manager.captureProjectSnapshot();
		const mediaManager = new MediaManager(host.editor);
		host.editor.selection.applySelectionPatch({
			patch: {
				selectedElements: [{ trackId: "video-track", elementId: "item-2" }],
			},
		});
		mediaManager.removeMediaAssets({
			projectId: "classic-project",
			ids: [original.id, original.id],
		});
		expect(host.media()).toHaveLength(0);
		expect(host.selection().selectedElements).toEqual([]);
		expect(
			host.project().scenes.map((scene) => scene.tracks.main.elements.length),
		).toEqual([0, 0]);
		expect(host.project().scenes[0].tracks.overlay[0].elements[0].id).toBe(
			"text-1",
		);
		const after = host.manager.captureProjectSnapshot();
		expect(
			(runtime.snapshot() as { project: { classic: CanonicalClassicSnapshot } })
				.project.classic.mediaAssets,
		).toHaveLength(0);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.media()[0].file).toBe(file);
		expect(host.media()[0].url).toBe("blob:owned-test-video");
		expect(host.selection().selectedElements).toEqual([
			{ trackId: "video-track", elementId: "item-2" },
		]);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.persistEditingSession();
		host.manager.detachCanonical();
		// The durable store still contains the original file; the canonical archive
		// determines membership and hides it until Undo, even after a new session.
		const reopened = createHost({ project: host.project(), media: [original] });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		expect(reopened.media()).toHaveLength(0);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(reopened.media()[0].file).toBe(file);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		const revision = reopened.manager.getStateRevision();
		expect(() =>
			reopened.manager.removeClassicMedia({
				projectId: "foreign-project",
				mediaIds: [original.id],
			}),
		).toThrow();
		expect(() =>
			reopened.manager.removeClassicMedia({
				projectId: "classic-project",
				mediaIds: ["missing"],
			}),
		).toThrow();
		expect(reopened.manager.getStateRevision()).toBe(revision);
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

function withoutSceneTimestamps(snapshot: SerializedProjectHistorySnapshot) {
	return {
		...snapshot,
		metadata: { ...snapshot.metadata, updatedAt: "timestamp" },
		scenes: snapshot.scenes.map((scene) => ({
			...scene,
			createdAt: "timestamp",
			updatedAt: "timestamp",
		})),
	};
}

function withoutKeyframeIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutKeyframeIds);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				key === "id" ? "generated-id" : withoutKeyframeIds(child),
			]),
		);
	}
	return value;
}

test(
	"ripple reactor shares exact-tick gap policy with the registry and one reopened undo",
	async () => {
		const { computeRippleAdjustments } = await import("@/ripple/diff");
		const { applyRippleAdjustments } = await import("@/ripple/apply");
		const seed = createHost();
		const project = structuredClone(seed.project());
		const original = project.scenes[0].tracks.main.elements[0];
		project.scenes[0].tracks.main.elements = [
			original,
			{
				...structuredClone(original),
				id: "later-a",
				startTime: mediaTime({ ticks: 1200000 }),
			},
			{
				...structuredClone(original),
				id: "later-b",
				startTime: mediaTime({ ticks: 2400001 }),
			},
		];
		const noRipple = createHost({
			project: structuredClone(project),
			media: seed.media(),
		});
		const baselineRuntime = await createCanonicalTestRuntime();
		await noRipple.manager.enableCanonical({ runtime: baselineRuntime });
		const beforeTracks = structuredClone(noRipple.project().scenes[0].tracks);
		noRipple.manager.removeClassicTimelineContent({
			type: "elements",
			elements: [{ trackId: "video-track", elementId: "item-2" }],
		});
		const afterTracks = noRipple.project().scenes[0].tracks;
		const expected = {
			...afterTracks,
			...applyRippleAdjustments({
				tracks: afterTracks,
				adjustments: computeRippleAdjustments({ beforeTracks, afterTracks }),
			}),
		};
		const host = createHost({
			project: structuredClone(project),
			media: seed.media(),
		});
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		host.manager.isRippleEnabled = true;
		host.manager.removeClassicTimelineContent({
			type: "elements",
			elements: [{ trackId: "video-track", elementId: "item-2" }],
		});
		expect(host.project().scenes[0].tracks).toEqual(expected);
		expect(
			host.project().scenes[0].tracks.main.elements.map((e) => e.startTime),
		).toEqual([mediaTime({ ticks: 0 }), mediaTime({ ticks: 1200001 })]);
		assertCoherent({ host, runtime });
		const after = host.manager.captureProjectSnapshot();
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(reopened.manager.canUndo()).toBe(false);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		for (const h of [host, noRipple, reopened]) {
			await h.manager.flushHistory();
			h.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"declarative canonical controls preserve scope, transaction rollback and reopened UI history",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		const control = {
			projectId: "classic-project",
			accountId: "local",
			capabilityId: "timeline.classic.track.update",
			input: {
				sceneId: "main-scene",
				trackId: "video-track",
				change: { type: "toggleMute" },
			},
		};
		for (const invalid of [
			{ ...control, projectId: "other" },
			{ ...control, accountId: "other" },
			{ ...control, capabilityId: "unknown.future" },
			{ ...control, input: { ...control.input, projectId: "other" } },
			{
				...control,
				capabilityId: "knowledge.search",
				input: { query: "", includeDisabled: false },
			},
		]) {
			expect(() => host.manager.invokeCanonicalControl(invalid)).toThrow();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			expect(host.manager.canUndo()).toBe(false);
		}
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.invokeCanonicalControl(control);
					host.manager.invokeCanonicalControl({
						...control,
						input: { ...control.input, trackId: "missing" },
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.invokeCanonicalControl(control);
		const after = host.manager.captureProjectSnapshot();
		expect(after!.scenes[0].tracks.main.muted).toBe(true);
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		host.manager.detachCanonical();
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"mask creation and parameter previews use product defaults without committing until confirmed",
	async () => {
		const host = createHost();
		(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks =
			[];
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		const target = { trackId: "video-track", elementId: "item-2" };
		for (const definition of masksRegistry.getAll()) {
			for (const elementSize of [
				undefined,
				{ width: 1920, height: 1080 },
				{ width: 1080, height: 1920 },
				{ width: 0, height: 100 },
			]) {
				const expected = buildDefaultMaskInstance({
					maskType: definition.type,
					elementSize,
				});
				const predicted = host.manager.previewClassicMask({
					...target,
					change: { type: "create", maskType: definition.type, elementSize },
				});
				expect(predicted).toEqual([{ ...expected, id: predicted[0].id }]);
				expect(host.manager.captureProjectSnapshot()).toEqual(before);
				host.manager.commitClassicMaskPreview();
				expect(
					(host.project().scenes[0].tracks.main.elements[0] as VideoElement)
						.masks,
				).toEqual(predicted);
				host.manager.undo();
				expect(host.manager.captureProjectSnapshot()).toEqual(before);
			}
		}
		const predicted = host.manager.previewClassicMask({
			...target,
			change: { type: "create", maskType: "rectangle" },
		});
		host.manager.commitClassicMaskPreview();
		const added = host.manager.captureProjectSnapshot();
		const maskId = predicted[0].id;
		host.manager.previewClassicMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 12 } },
		});
		const preview = host.manager.previewClassicMask({
			...target,
			maskId,
			change: { type: "update", params: { rotation: 37 } },
		});
		expect(preview[0].params.feather).toBe(12);
		expect(host.manager.captureProjectSnapshot()).toEqual(added);
		host.manager.commitClassicMaskPreview();
		const committed = host.manager.captureProjectSnapshot();
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(added);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(committed);
		host.manager.previewClassicMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 30 } },
		});
		host.manager.discardClassicMaskPreview();
		expect(host.manager.captureProjectSnapshot()).toEqual(committed);
		host.manager.previewClassicMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 30 } },
		});
		host.manager.editClassicMask({
			...target,
			maskId,
			change: { type: "toggleInverted" },
		});
		const intervening = host.manager.captureProjectSnapshot();
		expect(() => host.manager.commitClassicMaskPreview()).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(intervening);
		expect(host.manager.hasClassicMaskPreview()).toBe(false);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"mask timeline previews discard safely and never fall back to a stale track snapshot",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks =
			[];
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const timeline = new TimelineManager(host.editor);
		const target = { trackId: "video-track", elementId: "item-2" };
		const before = host.manager.captureProjectSnapshot();
		timeline.previewMask({
			...target,
			change: { type: "create", maskType: "rectangle" },
		});
		expect(timeline.isPreviewActive()).toBe(true);
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		timeline.discardPreview();
		timeline.commitPreview();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		timeline.previewMask({
			...target,
			change: { type: "create", maskType: "rectangle" },
		});
		timeline.commitPreview();
		const maskId = (
			host.project().scenes[0].tracks.main.elements[0] as VideoElement
		).masks![0].id;
		timeline.previewMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 20 } },
		});
		host.manager.editClassicMask({
			...target,
			maskId,
			change: { type: "toggleInverted" },
		});
		const intervening = host.manager.captureProjectSnapshot();
		expect(() => timeline.commitPreview()).toThrow();
		expect(timeline.isPreviewActive()).toBe(false);
		timeline.commitPreview();
		expect(host.manager.captureProjectSnapshot()).toEqual(intervening);
		timeline.previewMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 20 } },
		});
		timeline.previewElements({
			updates: [{ ...target, updates: { name: "Other preview" } }],
		});
		expect(host.manager.hasClassicMaskPreview()).toBe(false);
		expect(
			(timeline.getPreviewTracks()!.main.elements[0] as VideoElement).masks![0]
				.params.feather,
		).toBe(0);
		timeline.discardPreview();
		timeline.previewMask({
			...target,
			maskId,
			change: { type: "update", params: { feather: 30 } },
		});
		// Session teardown discards the prepared canonical request independently
		// of the mounted timeline. Its remaining projection must never commit.
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		timeline.commitPreview();
		expect(timeline.isPreviewActive()).toBe(false);
		expect(host.manager.captureProjectSnapshot()).toEqual(intervening);
	},
	INTEGRATION_TIMEOUT,
);

test(
	"new mask renderer definitions reach previews and the editing agent without tool wiring",
	async () => {
		const host = createHost();
		(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks =
			[];
		const initial = structuredClone(host.project());
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const target = { trackId: "video-track", elementId: "item-2" };
		host.manager.previewClassicMask({
			...target,
			change: { type: "create", maskType: "rectangle" },
		});
		const future = "future-mask" as import("@/masks/types").MaskType;
		const base = masksRegistry.get("rectangle");
		masksRegistry.register({
			key: future,
			definition: {
				...base,
				type: future,
				name: "Future mask",
				defaultSizing: "fixed",
			},
		});
		expect(() => host.manager.commitClassicMaskPreview()).toThrow(
			"catalog changed",
		);
		expect(
			(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks,
		).toEqual([]);
		host.manager.editClassicMask({
			...target,
			change: { type: "create", maskType: future, params: { feather: 9 } },
		});
		const ui = host.manager.captureProjectSnapshot();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const agent = createHost({ project: initial, media: host.media() });
		const agentRuntime = await createCanonicalTestRuntime();
		await agent.manager.enableCanonical({ runtime: agentRuntime });
		const run = await agent.manager.startEditingAgent({
			runId: "mask-catalog",
			request: "צור מסכה מהסוג החדש",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "mask",
					limit: 50,
				}),
			),
		).toContain("masks.classic.catalog.read");
		for (const id of [
			"masks.classic.catalog.read",
			"timeline.classic.masks.edit",
		])
			agent.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id,
			});
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Create mask", status: "inProgress" }],
		});
		const catalog = agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "mask-catalog",
			id: "masks.classic.catalog.read",
			input: { maskType: future, includeParameters: true },
		});
		expect(JSON.stringify(catalog)).toContain("Future mask");
		// The provider consumes the catalog receipt; its revision comes from the live host metadata.
		const signature = (
			agentRuntime.invokeSync(
				"masks.classic.catalog.read",
				{ projectId: "classic-project" },
				undefined,
			) as { result: { data: { catalogRevision: string } } }
		).result.data.catalogRevision;
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			callId: "mask-create",
			id: "timeline.classic.masks.edit",
			input: {
				sceneId: "main-scene",
				...target,
				catalogRevision: signature,
				change: { type: "create", maskType: future, params: { feather: 9 } },
			},
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(ui);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

function animationFixture(): ElementAnimations {
	const scalar = {
		extrapolation: { before: "hold" as const, after: "linear" as const },
		keys: [
			{
				id: "a",
				time: mediaTime({ ticks: 0 }),
				value: 0,
				segmentToNext: "bezier" as const,
				tangentMode: "broken" as const,
				rightHandle: { dt: mediaTime({ ticks: 80 }), dv: 0.5 },
			},
			{
				id: "b",
				time: mediaTime({ ticks: 100 }),
				value: 1,
				segmentToNext: "linear" as const,
				tangentMode: "flat" as const,
				leftHandle: { dt: mediaTime({ ticks: -80 }), dv: -0.5 },
				rightHandle: { dt: mediaTime({ ticks: 500 }), dv: 1 },
			},
			{
				id: "c",
				time: mediaTime({ ticks: 200 }),
				value: 2,
				segmentToNext: "linear" as const,
				tangentMode: "flat" as const,
				leftHandle: { dt: mediaTime({ ticks: -500 }), dv: -1 },
			},
		],
	};
	return structuredClone({
		opacity: scalar,
		color: { r: scalar, g: scalar, b: scalar },
		"params.future": scalar,
		"effects.future.params.mode": {
			keys: [
				{ id: "a", time: mediaTime({ ticks: 0 }), value: "off" },
				{ id: "b", time: mediaTime({ ticks: 100 }), value: "on" },
			],
		},
	});
}

test(
	"agent discovers live animation targets before keys exist and host teardown detaches metadata",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		try {
			const run = await host.manager.startEditingAgent({
				runId: "animation-target-discovery",
				request: "בדוק אילו מאפיינים אפשר להנפיש בקליפ",
			});
			expect(
				JSON.stringify(
					host.manager.executeEditingAgentCommand({
						type: "discover",
						query: "animation parameters",
						limit: 20,
					}),
				),
			).toContain("animation.classic.targets.read");
			host.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id: "animation.classic.targets.read",
			});
			const result = host.manager.executeEditingAgentCommand({
				type: "invoke",
				epoch: run.epoch,
				callId: "read-animation-targets",
				id: "animation.classic.targets.read",
				input: {
					sceneId: "main-scene",
					trackId: "video-track",
					elementId: "item-2",
					propertyPath: "opacity",
					includeParameters: true,
				},
			});
			expect(JSON.stringify(result)).toContain("channelLayout");
			expect(JSON.stringify(result)).toContain("opacity");
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
		} finally {
			host.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"UI and discovered agent author the same keyframes and effect values with atomic reopened undo",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		registerDefaultEffects();
		const definition = {
			...effectsRegistry.getAll()[0],
			type: "authoring-future-effect",
			params: [
				{
					key: "amount",
					label: "Amount",
					type: "number" as const,
					default: 0,
					min: 0,
					max: 10,
					step: 0.5,
				},
			],
		};
		effectsRegistry.register({ key: definition.type, definition });
		const host = createHost();
		const element = host.project().scenes[0].tracks.main
			.elements[0] as VideoElement;
		element.effects = [
			{
				id: "authoring-fx",
				type: definition.type,
				enabled: true,
				params: { amount: 0 },
			},
		];
		const initial = structuredClone(host.project());
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot();
		const target = { trackId: "video-track", elementId: "item-2" };
		const keys = [
			{
				...target,
				propertyPath: "opacity",
				time: mediaTime({ ticks: 0 }),
				value: 0.2,
				keyframeId: "opacity-start",
			},
			{
				...target,
				propertyPath: "opacity",
				time: mediaTime({ ticks: 100 }),
				value: 0.8,
				keyframeId: "opacity-end",
			},
		];
		timeline.previewElements({
			updates: [
				{ ...target, updates: { params: { ...element.params, opacity: 0.9 } } },
			],
		});
		expect(timeline.isPreviewActive()).toBe(true);
		host.manager.executeTransaction({
			execute: () => {
				timeline.upsertKeyframes({ keyframes: keys });
				timeline.upsertEffectParamKeyframe({
					...target,
					effectId: "authoring-fx",
					paramKey: "amount",
					time: mediaTime({ ticks: 50 }),
					value: 1.26,
					keyframeId: "effect-key",
				});
			},
		});
		expect(timeline.isPreviewActive()).toBe(false);
		const after = host.manager.captureProjectSnapshot();
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					timeline.upsertKeyframes({ keyframes: keys });
					timeline.upsertKeyframes({
						keyframes: [{ ...keys[0], value: "invalid" }],
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canRedo()).toBe(true);
		host.manager.redo();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.detachCanonical();
		const agent = createHost({ project: initial, media: host.media() });
		const runtime = await createCanonicalTestRuntime();
		await agent.manager.enableCanonical({ runtime });
		const run = await agent.manager.startEditingAgent({
			runId: "keyframe-authoring",
			request: "צור אנימציית שקיפות והנפש את האפקט החדש",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "keyframe",
					limit: 50,
				}),
			),
		).toContain("timeline.classic.keyframes.upsert");
		for (const id of [
			"animation.classic.targets.read",
			"timeline.classic.keyframes.upsert",
		])
			agent.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id,
			});
		const input = {
			projectId: "classic-project",
			sceneId: "main-scene",
			...target,
			propertyPath: "effects.authoring-fx.params.amount",
			includeParameters: true,
		};
		const receipt = agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "targets",
			id: "animation.classic.targets.read",
			input,
		});
		expect(JSON.stringify(receipt)).toContain("Amount");
		const catalogRevision = (
			runtime.invokeSync(
				"animation.classic.targets.read",
				input,
				undefined,
			) as {
				result: { data: { catalogRevision: string } };
			}
		).result.data.catalogRevision;
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			steps: [{ title: "Animate opacity and effect", status: "inProgress" }],
		});
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			callId: "create-keys",
			id: "timeline.classic.keyframes.upsert",
			input: {
				sceneId: "main-scene",
				catalogRevision,
				keyframes: [
					...keys,
					{
						...target,
						propertyPath: "effects.authoring-fx.params.amount",
						time: 50,
						value: 1.26,
						keyframeId: "effect-key",
					},
				],
			},
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(after);
		agent.manager.undo();
		expect(agent.manager.captureProjectSnapshot()).toEqual(before);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"UI and discovered agent remove keyframes with playhead preservation, effect base policy and reopened undo",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		registerDefaultEffects();
		const definition = {
			...effectsRegistry.getAll()[0],
			type: "removal-future-effect",
			params: [
				{
					key: "amount",
					label: "Amount",
					type: "number" as const,
					default: 0,
					min: 0,
					max: 10,
					step: 0.01,
				},
			],
		};
		effectsRegistry.register({ key: definition.type, definition });
		const host = createHost();
		const element = host.project().scenes[0].tracks.main
			.elements[0] as VideoElement;
		element.effects = [
			{
				id: "remove-fx",
				type: definition.type,
				enabled: true,
				params: { amount: 0.15 },
			},
		];
		element.animations = {
			opacity: animationFixture().opacity,
			"effects.remove-fx.params.amount": animationFixture().opacity,
		};
		const initial = structuredClone(host.project());
		const playheadTime = element.startTime + 50;
		Object.assign(host.editor, {
			playback: { getCurrentTime: () => playheadTime },
		});
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot();
		const target = { trackId: "video-track", elementId: "item-2" };
		const keys = ["a", "b", "c"].map((keyframeId) => ({
			...target,
			propertyPath: "opacity",
			keyframeId,
		}));
		// General deletion on an effect persists the sampled value to that instance.
		timeline.removeKeyframes({
			keyframes: keys.map((key) => ({
				...key,
				propertyPath: "effects.remove-fx.params.amount",
			})),
		});
		const sampledEffect = host.manager.captureProjectSnapshot()!.scenes[0]
			.tracks.main.elements[0] as VideoElement;
		expect(sampledEffect.effects?.[0].params.amount).toBeCloseTo(0.5, 2);
		expect(sampledEffect.params).toEqual(element.params);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		timeline.previewElements({
			updates: [
				{ ...target, updates: { params: { ...element.params, opacity: 0.9 } } },
			],
		});
		host.manager.executeTransaction({
			execute: () => {
				timeline.removeKeyframes({ keyframes: keys });
				for (const keyframeId of ["a", "b", "c"])
					timeline.removeEffectParamKeyframe({
						...target,
						effectId: "remove-fx",
						paramKey: "amount",
						keyframeId,
					});
			},
		});
		const after = host.manager.captureProjectSnapshot()!;
		const clip = after.scenes[0].tracks.main.elements[0] as VideoElement;
		expect(clip.params.opacity).toBeCloseTo(0.5, 2);
		expect(clip.effects?.[0].params.amount).toBe(0.15);
		expect(clip.animations).toBeUndefined();
		expect(timeline.isPreviewActive()).toBe(false);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					timeline.removeKeyframes({ keyframes: keys });
					timeline.removeKeyframes({
						keyframes: [{ ...keys[0], keyframeId: "missing" }],
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canRedo()).toBe(true);
		host.manager.redo();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.detachCanonical();
		const agent = createHost({ project: initial, media: host.media() });
		const runtime = await createCanonicalTestRuntime();
		await agent.manager.enableCanonical({ runtime });
		const run = await agent.manager.startEditingAgent({
			runId: "keyframe-removal",
			request: "מחק את האנימציה ושמור את השקיפות הנוכחית",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "keyframe",
					limit: 50,
				}),
			),
		).toContain("timeline.classic.keyframes.remove");
		agent.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "timeline.classic.keyframes.remove",
		});
		const catalogRevision = (
			runtime.invokeSync(
				"animation.classic.targets.read",
				{ projectId: "classic-project", sceneId: "main-scene", ...target },
				undefined,
			) as { result: { data: { catalogRevision: string } } }
		).result.data.catalogRevision;
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Remove animation", status: "inProgress" }],
		});
		for (const preserveAtPlayhead of [true, false]) {
			agent.manager.executeEditingAgentCommand({
				type: "invoke",
				epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
				callId: `remove-${preserveAtPlayhead}`,
				id: "timeline.classic.keyframes.remove",
				input: {
					sceneId: "main-scene",
					catalogRevision,
					playheadTime,
					preserveAtPlayhead,
					keyframes: keys.map((key) => ({
						...key,
						propertyPath: preserveAtPlayhead
							? "opacity"
							: "effects.remove-fx.params.amount",
					})),
				},
			});
		}
		expect(agent.manager.captureProjectSnapshot()).toEqual(after);
		agent.manager.undo();
		agent.manager.undo();
		expect(agent.manager.captureProjectSnapshot()).toEqual(before);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"ClipboardManager and discovered agent copy and paste the same animation with atomic reopened history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { ClipboardManager } =
			await import("@/core/managers/clipboard-manager");
		const host = createHost();
		const element = host.project().scenes[0].tracks.main
			.elements[0] as VideoElement;
		element.animations = { opacity: animationFixture().opacity };
		const initial = structuredClone(host.project());
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const timeline = new TimelineManager(host.editor);
		Object.assign(host.editor, {
			timeline,
			playback: { getCurrentTime: () => mediaTime({ ticks: 300 }) },
		});
		Object.assign(host.editor.selection, {
			getSelectedElements: () => host.selection().selectedElements,
			getSelectedKeyframes: () => host.selection().selectedKeyframes,
		});
		const target = { trackId: "video-track", elementId: "item-2" };
		const refs = ["c", "a"].map((keyframeId) => ({
			...target,
			propertyPath: "opacity",
			keyframeId,
		}));
		host.editor.selection.applySelectionPatch({
			patch: { selectedElements: [target], selectedKeyframes: refs },
		});
		const clipboard = new ClipboardManager(host.editor);
		const before = host.manager.captureProjectSnapshot();
		expect(clipboard.copy()).toBe(true);
		const entry = clipboard.getEntry();
		if (entry?.type !== "keyframes")
			throw new Error("Expected copied keyframes");
		expect(entry.items.map((i) => i.timeOffset)).toEqual([
			mediaTime({ ticks: 0 }),
			mediaTime({ ticks: 200 }),
		]);
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		timeline.previewElements({
			updates: [
				{ ...target, updates: { params: { ...element.params, opacity: 0.9 } } },
			],
		});
		expect(clipboard.paste()).toBe(true);
		expect(timeline.isPreviewActive()).toBe(false);
		const after = host.manager.captureProjectSnapshot();
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.pasteClassicKeyframes({
						...target,
						time: 300,
						items: entry.items,
					});
					host.manager.pasteClassicKeyframes({
						...target,
						time: 300,
						items: [{ ...entry.items[0], value: "invalid" }],
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canRedo()).toBe(true);
		host.manager.redo();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.detachCanonical();
		const agent = createHost({ project: initial, media: host.media() });
		const runtime = await createCanonicalTestRuntime();
		await agent.manager.enableCanonical({ runtime });
		const run = await agent.manager.startEditingAgent({
			runId: "animation-clipboard",
			request: "העתק את אנימציית השקיפות והדבק אותה בהמשך הקליפ",
		});
		const discovery = JSON.stringify(
			agent.manager.executeEditingAgentCommand({
				type: "discover",
				query: "clipboard",
				limit: 50,
			}),
		);
		expect(discovery).toContain("animation.classic.keyframes.copy");
		expect(discovery).toContain("timeline.classic.keyframes.paste");
		for (const id of [
			"animation.classic.keyframes.copy",
			"timeline.classic.keyframes.paste",
		])
			agent.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id,
			});
		const read = agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "copy-keys",
			id: "animation.classic.keyframes.copy",
			input: {
				sceneId: "main-scene",
				...target,
				keyframes: refs.map(({ propertyPath, keyframeId }) => ({
					propertyPath,
					keyframeId,
				})),
			},
		});
		expect(JSON.stringify(read)).toContain("curvePatches");
		expect(agent.manager.captureProjectSnapshot()).toEqual(before);
		const catalogRevision = (
			runtime.invokeSync(
				"animation.classic.targets.read",
				{ projectId: "classic-project", sceneId: "main-scene", ...target },
				undefined,
			) as { result: { data: { catalogRevision: string } } }
		).result.data.catalogRevision;
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			steps: [{ title: "Paste copied animation", status: "inProgress" }],
		});
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			callId: "paste-keys",
			id: "timeline.classic.keyframes.paste",
			input: {
				sceneId: "main-scene",
				...target,
				time: 300,
				catalogRevision,
				items: entry.items,
			},
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(after);
		agent.manager.undo();
		expect(agent.manager.captureProjectSnapshot()).toEqual(before);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"canonical keyframe retiming and curves match Classic channels and retain one undo boundary",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const element = host.project().scenes[0].tracks.main
			.elements[0] as VideoElement;
		element.animations = animationFixture();
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot()!;
		const target = {
			trackId: "video-track",
			elementId: "item-2",
			keyframeId: "b",
		};
		for (const propertyPath of Object.keys(element.animations)) {
			for (const ticks of [-100, 0, 50, 100, 250, element.duration + 100]) {
				const expected = structuredClone(before);
				const clip = expected.scenes[0].tracks.main.elements[0] as VideoElement;
				clip.animations = retimeElementKeyframe({
					animations: clip.animations,
					propertyPath,
					keyframeId: "b",
					time: mediaTime({
						ticks: Math.max(0, Math.min(ticks, element.duration)),
					}),
				});
				timeline.retimeKeyframe({
					...target,
					propertyPath,
					time: mediaTime({ ticks }),
				});
				expect(
					JSON.parse(JSON.stringify(host.manager.captureProjectSnapshot())),
				).toEqual(JSON.parse(JSON.stringify(expected)));
				host.manager.undo();
				expect(host.manager.captureProjectSnapshot()).toEqual(before);
			}
		}
		for (const patch of [
			{ leftHandle: null, rightHandle: null },
			{
				leftHandle: { dt: mediaTime({ ticks: -1000 }), dv: 3 },
				rightHandle: { dt: mediaTime({ ticks: 1000 }), dv: -2 },
				segmentToNext: "bezier",
				tangentMode: "aligned",
			},
			{ segmentToNext: "step", tangentMode: "auto" },
		] satisfies ScalarCurveKeyframePatch[]) {
			const expected = structuredClone(before);
			const clip = expected.scenes[0].tracks.main.elements[0] as VideoElement;
			for (const [propertyPath, componentKey] of [
				["opacity", "value"],
				["color", "g"],
			]) {
				clip.animations = updateScalarKeyframeCurve({
					animations: clip.animations,
					propertyPath,
					componentKey,
					keyframeId: "b",
					patch,
				});
			}
			timeline.previewElements({
				updates: [
					{
						trackId: target.trackId,
						elementId: target.elementId,
						updates: { animations: clip.animations },
					},
				],
			});
			expect(timeline.isPreviewActive()).toBe(true);
			timeline.updateKeyframeCurves({
				keyframes: [
					{ ...target, propertyPath: "opacity", componentKey: "value", patch },
					{ ...target, propertyPath: "color", componentKey: "g", patch },
				],
			});
			expect(timeline.isPreviewActive()).toBe(false);
			expect(
				JSON.parse(JSON.stringify(host.manager.captureProjectSnapshot())),
			).toEqual(JSON.parse(JSON.stringify(expected)));
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
		}
		timeline.retimeKeyframes({
			keyframes: [
				{ ...target, propertyPath: "opacity", time: mediaTime({ ticks: 50 }) },
				{ ...target, propertyPath: "color", time: mediaTime({ ticks: 75 }) },
			],
		});
		const after = host.manager.captureProjectSnapshot();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"keyframe gestures reject stale sessions and the editing agent uses the same atomic contract",
	async () => {
		const host = createHost();
		(
			host.project().scenes[0].tracks.main.elements[0] as VideoElement
		).animations = animationFixture();
		const initial = structuredClone(host.project());
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const before = host.manager.captureProjectSnapshot();
		const edits: ClassicKeyframeEdit[] = [
			{
				trackId: "video-track",
				elementId: "item-2",
				propertyPath: "params.future",
				keyframeId: "b",
				change: { type: "retime", time: 40 },
			},
		];
		expect(() =>
			host.manager.editClassicKeyframes({
				edits: [...edits, { ...edits[0], keyframeId: "missing" }],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicKeyframes({ edits });
					throw new Error("compound rollback");
				},
			}),
		).toThrow("compound rollback");
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		const stale = host.manager.prepareClassicKeyframeEdit();
		host.manager.editClassicKeyframes({ edits });
		const after = host.manager.captureProjectSnapshot();
		expect(() => stale(edits)).toThrow("editor changed");
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		const released = host.manager.prepareClassicKeyframeEdit();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		expect(() => released(edits)).toThrow("editor changed");
		const agent = createHost({ project: initial, media: host.media() });
		await agent.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const run = await agent.manager.startEditingAgent({
			runId: "keyframe-agent",
			request: "הזז את הקיפריים של המאפיין החדש",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "keyframe",
					limit: 50,
				}),
			),
		).toContain("timeline.classic.keyframes.edit");
		agent.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "timeline.classic.keyframes.edit",
		});
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Adjust timing", status: "inProgress" }],
		});
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "move-key",
			id: "timeline.classic.keyframes.edit",
			input: { sceneId: "main-scene", edits },
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(after);
		agent.manager.undo();
		expect(agent.manager.captureProjectSnapshot()).toEqual(before);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"keyframe drag dispatches canonical edits and always releases a rejected gesture",
	async () => {
		const { KeyframeDragController } =
			await import("@/timeline/controllers/keyframe-drag-controller");
		const host = createHost();
		const element = host.project().scenes[0].tracks.main
			.elements[0] as VideoElement;
		element.animations = animationFixture();
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const listeners = new Map<
			string,
			Set<(event: { clientX: number }) => void>
		>();
		const originalDocument = Object.getOwnPropertyDescriptor(
			globalThis,
			"document",
		);
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				addEventListener: (
					name: string,
					fn: (event: { clientX: number }) => void,
				) => {
					if (!listeners.has(name)) listeners.set(name, new Set());
					listeners.get(name)!.add(fn);
				},
				removeEventListener: (
					name: string,
					fn: (event: { clientX: number }) => void,
				) => {
					listeners.get(name)?.delete(fn);
				},
			},
		});
		const keyframes = [
			{
				trackId: "video-track",
				elementId: "item-2",
				propertyPath: "opacity",
				keyframeId: "b",
			},
		];
		const controller = new KeyframeDragController({
			configRef: {
				current: {
					zoomLevel: 1,
					element,
					displayedStartTime: element.startTime,
					getFps: () => ({ numerator: 30, denominator: 1 }),
					selectedKeyframes: keyframes,
					isKeyframeSelected: () => true,
					setKeyframeSelection: () => {},
					toggleKeyframeSelection: () => {},
					selectKeyframeRange: () => {},
					prepareEdit: () => host.manager.prepareClassicKeyframeEdit(),
					seek: () => {},
					getTotalDuration: () => element.duration,
				},
			},
		});
		const dispatch = ({
			name,
			clientX = 40,
		}: {
			name: string;
			clientX?: number;
		}) => {
			for (const fn of listeners.get(name) ?? []) fn({ clientX });
		};
		const begin = () => {
			controller.onKeyframeMouseDown({
				keyframes,
				event: {
					clientX: 0,
					preventDefault() {},
					stopPropagation() {},
					shiftKey: false,
					metaKey: false,
					ctrlKey: false,
				} as import("react").MouseEvent,
			});
			dispatch({ name: "mousemove", clientX: 20 });
			dispatch({ name: "mousemove", clientX: 40 });
		};
		try {
			const before = host.manager.captureProjectSnapshot();
			begin();
			dispatch({ name: "mouseup" });
			expect(controller.isActive).toBe(false);
			expect(listeners.get("mousemove")?.size).toBe(0);
			expect(host.manager.captureProjectSnapshot()).not.toEqual(before);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			begin();
			host.manager.editClassicKeyframes({
				edits: [{ ...keyframes[0], change: { type: "retime", time: 30 } }],
			});
			const intervening = host.manager.captureProjectSnapshot();
			expect(() => dispatch({ name: "mouseup" })).toThrow("editor changed");
			expect(controller.isActive).toBe(false);
			expect(listeners.get("mouseup")?.size).toBe(0);
			expect(host.manager.captureProjectSnapshot()).toEqual(intervening);
		} finally {
			controller.destroy();
			if (originalDocument)
				Object.defineProperty(globalThis, "document", originalDocument);
			else Reflect.deleteProperty(globalThis, "document");
			await host.manager.flushHistory();
			host.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

function maskFixture({
	curved = false,
	closed = true,
}: { curved?: boolean; closed?: boolean } = {}): FreeformPathMask {
	return {
		id: "shape",
		type: "freeform",
		params: {
			centerX: 0.13,
			centerY: -0.11,
			rotation: 27,
			scale: 1.3,
			closed,
			inverted: false,
			feather: 3,
			strokeColor: "#ffffff",
			strokeWidth: 0,
			strokeAlign: "center",
			path: [
				{
					id: "a",
					x: -0.25,
					y: -0.25,
					inX: curved ? -0.12 : 0,
					inY: 0,
					outX: curved ? 0.2 : 0,
					outY: curved ? -0.3 : 0,
				},
				{
					id: "b",
					x: 0.25,
					y: -0.25,
					inX: curved ? -0.1 : 0,
					inY: curved ? 0.3 : 0,
					outX: 0,
					outY: 0,
				},
				{
					id: "c",
					x: 0,
					y: 0.25,
					inX: 0,
					inY: 0,
					outX: curved ? 0.1 : 0,
					outY: 0,
				},
			],
		},
	};
}

test(
	"Classic masks preserve freeform geometry, selection and reopened undo history",
	async () => {
		for (const [curved, closed, segmentIndex, width] of [
			[false, true, 0, 1920],
			[true, true, 0, 1920],
			[true, true, 2, 1920],
			[true, false, 1, 1920],
			[false, false, 0, 0],
		] as const) {
			const host = createHost();
			const mask = maskFixture({ curved, closed });
			(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks =
				[mask];
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const before = host.manager.captureProjectSnapshot();
			const bounds = { cx: 960, cy: 540, width, height: 1080, rotation: 15 };
			const canvasPoint = { x: 805, y: 341 };
			const target = {
				trackId: "video-track",
				elementId: "item-2",
				maskId: "shape",
			};
			const result = host.manager.editClassicMask({
				...target,
				change: { type: "insertPoint", segmentIndex, canvasPoint, bounds },
			});
			const expected = insertPointOnFreeformSegment({
				params: mask.params,
				segmentIndex,
				canvasPoint,
				bounds,
				pointId: result.insertedPointId!,
			})!;
			const actual = (
				host.project().scenes[0].tracks.main.elements[0] as VideoElement
			).masks![0] as FreeformPathMask;
			expect(actual.params.centerX).toBeCloseTo(expected.params.centerX, 11);
			expect(actual.params.centerY).toBeCloseTo(expected.params.centerY, 11);
			expect(actual.params.path.length).toBe(expected.params.path.length);
			for (const [i, point] of actual.params.path.entries()) {
				expect(point.id).toBe(expected.params.path[i].id);
				for (const key of ["x", "y", "inX", "inY", "outX", "outY"] as const)
					expect(point[key]).toBeCloseTo(expected.params.path[i][key], 11);
			}
			expect(host.selection().selectedMaskPoints).toEqual({
				...target,
				pointIds: [result.insertedPointId!],
			});
			const after = host.manager.captureProjectSnapshot()!;
			const unchanged = structuredClone(after);
			(unchanged.scenes[0].tracks.main.elements[0] as VideoElement).masks = [
				mask,
			];
			expect(unchanged).toEqual(before!);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			expect(host.selection().selectedMaskPoints).toBeNull();
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			expect(host.selection().selectedMaskPoints?.pointIds).toEqual([
				result.insertedPointId!,
			]);
			host.manager.editClassicMask({
				...target,
				change: {
					type: "deletePoints",
					pointIds: [result.insertedPointId!, "b"],
				},
			});
			expect(host.selection().selectedMaskPoints).toBeNull();
			const deleted = host.manager.captureProjectSnapshot();
			await host.manager.flushHistory();
			const reopened = createHost({
				project: structuredClone(host.project()),
				media: host.media(),
			});
			host.manager.detachCanonical();
			await reopened.manager.loadHistory({ projectId: "classic-project" });
			await reopened.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
			});
			reopened.manager.undo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
			expect(reopened.selection().selectedMaskPoints?.pointIds).toEqual([
				result.insertedPointId!,
			]);
			reopened.manager.redo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(deleted);
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"Classic masks are shared by discovered agent and UI actions with atomic rollback",
	async () => {
		const host = createHost();
		(host.project().scenes[0].tracks.main.elements[0] as VideoElement).masks = [
			maskFixture(),
		];
		const initial = structuredClone(host.project());
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const target = {
			trackId: "video-track",
			elementId: "item-2",
			maskId: "shape",
		};
		const before = host.manager.captureProjectSnapshot();
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicMask({
						...target,
						change: {
							type: "insertPoint",
							segmentIndex: 0,
							canvasPoint: { x: 100, y: 100 },
							bounds: {
								cx: 960,
								cy: 540,
								width: 1920,
								height: 1080,
								rotation: 0,
							},
						},
					});
					host.manager.editClassicMask({
						...target,
						maskId: "missing",
						change: { type: "remove" },
					});
				},
			}),
		).toThrow("exactly one mask");
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection().selectedMaskPoints).toBeNull();
		const changes = [
			{ type: "toggleInverted" },
			{ type: "setInverted", inverted: false },
			{ type: "deletePoints", pointIds: ["a"] },
			{ type: "remove" },
		] as const;
		const states = [];
		for (const change of changes) {
			host.manager.editClassicMask({
				...target,
				change: structuredClone(
					change,
				) as import("@/core/canonical-classic-session").ClassicMaskChange,
			});
			states.push(host.manager.captureProjectSnapshot());
		}
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const agent = createHost({ project: initial, media: host.media() });
		await agent.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const run = await agent.manager.startEditingAgent({
			runId: "mask-edit",
			request: "ערוך את מסכת הסרטון ושמור את השאר",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "mask",
					limit: 50,
				}),
			),
		).toContain("timeline.classic.masks.edit");
		agent.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "timeline.classic.masks.edit",
		});
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Edit mask", status: "inProgress" }],
		});
		for (const [i, change] of changes.entries()) {
			agent.manager.executeEditingAgentCommand({
				type: "invoke",
				epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
				callId: `mask-${i}`,
				id: "timeline.classic.masks.edit",
				input: { sceneId: "main-scene", ...target, change },
			});
			expect(agent.manager.captureProjectSnapshot()).toEqual(states[i]);
		}
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"Classic effects use live product defaults, preserve extension data and coalesce previews",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		const target = { trackId: "video-track", elementId: "item-2" };
		registerDefaultEffects();
		for (const effectType of [
			...effectsRegistry.getAll().map((d) => d.type),
			"Zoom Blur",
			"blurzoom",
			"liquid neon burst",
			"",
		]) {
			const expected = buildDefaultEffectInstance({
				effectType,
				params: { extra: "preserve", intensity: 23, ignored: undefined },
			});
			const effectId = host.manager.editClassicEffects({
				...target,
				change: {
					type: "add",
					effectType,
					params: { extra: "preserve", intensity: 23, ignored: undefined },
					allowCustomFallback: true,
				},
			});
			const edited = host.manager.captureProjectSnapshot()!;
			const source = edited.scenes[0].tracks.main.elements[0] as VideoElement;
			expect(source.effects?.at(-1)).toEqual({ ...expected, id: effectId! });
			expect<TimelineElement>({
				...source,
				effects: before.scenes[0].tracks.main.elements[0].effects,
			}).toEqual(before.scenes[0].tracks.main.elements[0]);
			expect(edited.scenes[1]).toEqual(before.scenes[1]);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
		}
		const effectId = host.manager.editClassicEffects({
			...target,
			change: { type: "add", effectType: "blur" },
		})!;
		const added = host.manager.captureProjectSnapshot()!;
		for (const [intensity, pushHistory] of [
			[30, false],
			[40, false],
			[50, true],
		] as const) {
			host.manager.editClassicEffects({
				...target,
				change: { type: "update", effectId, params: { intensity } },
				pushHistory,
			});
		}
		const updated = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(added);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(updated);
		host.manager.editClassicEffects({
			...target,
			change: { type: "toggle", effectId },
		});
		expect(
			(
				host.project().scenes[0].tracks.main.elements[0] as VideoElement
			).effects?.at(-1)?.enabled,
		).toBe(false);
		host.manager.editClassicEffects({
			...target,
			change: { type: "reorder", fromIndex: 1, toIndex: 0 },
		});
		expect(
			(host.project().scenes[0].tracks.main.elements[0] as VideoElement)
				.effects?.[0].id,
		).toBe(effectId);
		host.manager.editClassicEffects({
			...target,
			change: { type: "remove", effectId },
		});
		const removed = host.manager.captureProjectSnapshot()!;
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		host.manager.detachCanonical();
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(
			(reopened.project().scenes[0].tracks.main.elements[0] as VideoElement)
				.effects?.[0].id,
		).toBe(effectId);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(removed);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"future product effects appear in agent discovery without agent wiring and compound errors roll back",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		const target = { trackId: "video-track", elementId: "item-2" };
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicEffects({
						...target,
						change: { type: "add", effectType: "blur" },
					});
					host.manager.editClassicEffects({
						...target,
						change: { type: "reorder", fromIndex: 999, toIndex: 0 },
					});
				},
			}),
		).toThrow("out of range");
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		const catalog = () =>
			(
				runtime.invokeSync(
					"effects.classic.catalog.read",
					{ projectId: "classic-project", includeParameters: true },
					undefined,
				) as {
					result: { data: { catalogRevision: string; definitions: unknown[] } };
				}
			).result.data;
		const agent = createHost();
		const agentRuntime = await createCanonicalTestRuntime();
		await agent.manager.enableCanonical({ runtime: agentRuntime });
		const run = await agent.manager.startEditingAgent({
			runId: "effect-edit",
			request: "הוסף את האפקט החדש לסרטון",
		});
		const old = catalog();
		effectsRegistry.register({
			key: "future-editor-effect",
			definition: {
				type: "future-editor-effect",
				name: "Future effect",
				keywords: ["future"],
				params: [
					{
						key: "strength",
						label: "Strength",
						type: "number",
						default: 0.6,
						min: 0,
						step: 0.01,
					},
				],
				renderer: { passes: [] },
			},
		});
		const futureRevision = catalog().catalogRevision;
		expect(futureRevision).not.toBe(old.catalogRevision);
		expect(JSON.stringify(catalog().definitions)).toContain(
			"future-editor-effect",
		);
		expect(() =>
			runtime.invokeSync(
				"timeline.classic.effects.edit",
				{
					projectId: "classic-project",
					expectedRevision: (runtime.snapshot() as { revision: number })
						.revision,
					sceneId: "main-scene",
					...target,
					catalogRevision: old.catalogRevision,
					change: { type: "add", effectType: "future-editor-effect" },
				},
				undefined,
			),
		).toThrow("catalog changed");
		host.manager.editClassicEffects({
			...target,
			change: { type: "add", effectType: "future-editor-effect" },
		});
		const ui = host.manager.captureProjectSnapshot();
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "effects",
					limit: 50,
				}),
			),
		).toContain("effects.classic.catalog.read");
		for (const id of [
			"effects.classic.catalog.read",
			"timeline.classic.effects.edit",
		])
			agent.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id,
			});
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Add product effect", status: "inProgress" }],
		});
		const result = agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "catalog",
			id: "effects.classic.catalog.read",
			input: { query: "future", includeParameters: true },
		});
		expect(JSON.stringify(result)).toContain("future-editor-effect");
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.manager.getEditingAgentSnapshot()!.epoch,
			callId: "add-effect",
			id: "timeline.classic.effects.edit",
			input: {
				sceneId: "main-scene",
				...target,
				catalogRevision: futureRevision,
				change: { type: "add", effectType: "future-editor-effect" },
			},
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(ui);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"source audio extraction matches Classic placement, retime and volume curve semantics",
	async () => {
		for (const placement of ["new", "touching", "displayOrder"] as const) {
			const host = createHost();
			const source = host.project().scenes[0].tracks.main
				.elements[0] as VideoElement;
			source.params.volume = -6;
			source.params.muted = true;
			source.params.audioSyncOffset = 1.25;
			source.params.fadeInDuration = 0.4;
			source.params.fadeOutDuration = 0.6;
			source.sourceDuration = mediaTime({ ticks: 1_920_000 });
			// Older serialized projects can carry an explicit null optional duration.
			if (placement === "displayOrder")
				Object.assign(source, { sourceDuration: null });
			source.retime = { rate: 1.25, maintainPitch: false };
			source.animations = {
				volume: {
					extrapolation: { before: "hold", after: "linear" },
					keys: [
						{
							id: "late",
							time: mediaTime({ ticks: 120000 }),
							value: -10,
							segmentToNext: "bezier",
							tangentMode: "broken",
							leftHandle: { dt: mediaTime({ ticks: -240000 }), dv: 3 },
							rightHandle: { dt: mediaTime({ ticks: 500 }), dv: 2 },
						},
						{
							id: "early",
							time: mediaTime({ ticks: 0 }),
							value: 0,
							segmentToNext: "linear",
							tangentMode: "flat",
							leftHandle: { dt: mediaTime({ ticks: -1 }), dv: 0 },
							rightHandle: { dt: mediaTime({ ticks: 240000 }), dv: 5 },
						},
					],
				},
				opacity: {
					keys: [
						{
							id: "opacity",
							time: mediaTime({ ticks: 0 }),
							value: 0.5,
							segmentToNext: "linear",
							tangentMode: "flat",
						},
					],
				},
			};
			if (placement !== "new") {
				const audio = ({
					id,
					start,
				}: {
					id: string;
					start: number;
				}): AudioElement => ({
					...buildSeparatedAudioElement({ sourceElement: source }),
					id,
					startTime: mediaTime({ ticks: start }),
					duration: mediaTime({ ticks: 100 }),
				});
				host.project().scenes[0].tracks.audio = [
					{
						...buildEmptyTrack({ id: "available", type: "audio" }),
						elements: [],
					},
					{
						...buildEmptyTrack({ id: "touching", type: "audio" }),
						muted: true,
						elements: [audio({ id: "touch-end", start: source.duration })],
					},
					{
						...buildEmptyTrack({ id: "busy", type: "audio" }),
						elements: [audio({ id: "overlap", start: 500 })],
					},
				];
				host.project().scenes[0].tracks.order =
					placement === "touching"
						? ["busy", "touching", "available", "titles", "video-track"]
						: ["available", "touching", "busy", "titles", "video-track"];
			}
			host.editor.scenes.initializeScenes({
				scenes: host.project().scenes,
				currentSceneId: host.project().currentSceneId,
			});
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const before = host.manager.captureProjectSnapshot()!;
			const expectedAudio = buildSeparatedAudioElement({
				sourceElement: source,
			});
			// The frozen legacy builder dropped sync offsets and fades. Canonical
			// extraction deliberately fixes that loss while preserving its layout.
			Object.assign(expectedAudio.params, {
				audioSyncOffset: 1.25,
				fadeInDuration: 0.4,
				fadeOutDuration: 0.6,
			});
			const expectedPlacement = resolveTrackPlacement({
				tracks: before.scenes[0].tracks,
				trackType: "audio",
				timeSpans: [{ startTime: source.startTime, duration: source.duration }],
				strategy: { type: "firstAvailable" },
			})!;
			host.manager.editClassicSourceAudio({
				trackId: "video-track",
				elementId: "item-2",
				action: "toggle",
			});
			const edited = host.manager.captureProjectSnapshot()!;
			const target = edited.scenes[0].tracks.audio.find((track) =>
				track.elements.some(
					(element) =>
						!before.scenes[0].tracks.audio.some((oldTrack) =>
							oldTrack.elements.some((old) => old.id === element.id),
						),
				),
			)!;
			const audio = target.elements.at(-1)!;
			expect(getClipAudioTiming(audio)).toEqual(getClipAudioTiming(source));
			expect(withoutKeyframeIds(audio)).toEqual(
				withoutKeyframeIds(
					JSON.parse(JSON.stringify({ ...expectedAudio, id: audio.id })),
				),
			);
			if (expectedPlacement.kind === "existingTrack")
				expect(target.id).toBe(expectedPlacement.trackId);
			else {
				expect(
					edited.scenes[0].tracks.order?.[expectedPlacement.insertIndex],
				).toBe(target.id);
				expect(target).toEqual({
					...buildEmptyTrack({ id: target.id, type: "audio" }),
					elements: [audio],
				});
			}
			const volumeKeys = (
				audio.animations!.volume as { keys: Array<{ id: string }> }
			).keys;
			expect(volumeKeys.map((key) => key.id)).not.toContain("late");
			expect(volumeKeys.map((key) => key.id)).not.toContain("early");
			expect<TimelineElement>(edited.scenes[0].tracks.main.elements[0]).toEqual(
				{
					...(before.scenes[0].tracks.main.elements[0] as VideoElement),
					isSourceAudioEnabled: false,
				},
			);
			expect(edited.scenes[1]).toEqual(before.scenes[1]);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(edited);
			host.manager.editClassicSourceAudio({
				trackId: "video-track",
				elementId: "item-2",
				action: "toggle",
			});
			expect(host.project().scenes[0].tracks.audio).toEqual(
				edited.scenes[0].tracks.audio,
			);
			expect(
				(host.project().scenes[0].tracks.main.elements[0] as VideoElement)
					.isSourceAudioEnabled,
			).toBe(true);
			host.manager.undo();
			await host.manager.flushHistory();
			const reopened = createHost({
				project: structuredClone(host.project()),
				media: host.media(),
			});
			host.manager.detachCanonical();
			await reopened.manager.loadHistory({ projectId: "classic-project" });
			await reopened.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
			});
			reopened.manager.undo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
			reopened.manager.redo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(edited);
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"source audio is discovered by the agent and cannot partially commit a compound failure",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicSourceAudio({
						trackId: "video-track",
						elementId: "item-2",
						action: "extract",
					});
					host.manager.editClassicSourceAudio({
						trackId: "video-track",
						elementId: "item-2",
						action: "extract",
					});
				},
			}),
		).toThrow("already disabled");
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.editClassicSourceAudio({
			trackId: "video-track",
			elementId: "item-2",
			action: "extract",
		});
		const ui = host.manager.captureProjectSnapshot()!;
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const agent = createHost();
		await agent.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const run = await agent.manager.startEditingAgent({
			runId: "separate-audio",
			request: "הפרד את האודיו של הווידאו כדי שאוכל לערוך אותו בנפרד",
		});
		expect(
			JSON.stringify(
				agent.manager.executeEditingAgentCommand({
					type: "discover",
					query: "source audio",
					limit: 50,
				}),
			),
		).toContain("timeline.classic.audio.source.edit");
		agent.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "timeline.classic.audio.source.edit",
		});
		agent.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Extract audio", status: "inProgress" }],
		});
		agent.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "extract",
			id: "timeline.classic.audio.source.edit",
			input: {
				sceneId: "main-scene",
				trackId: "video-track",
				elementId: "item-2",
				action: "extract",
			},
		});
		expect(agent.manager.captureProjectSnapshot()).toEqual(ui);
		await agent.manager.flushHistory();
		agent.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"scene UI lifecycle and discovered agent contracts preserve the same project and reopen undo",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		const sceneId = await host.editor.scenes.createScene({
			name: "סצנת פתיחה",
			isMain: false,
		});
		const created = host
			.project()
			.scenes.find((scene) => scene.id === sceneId)!;
		expect(created.tracks.main).toMatchObject({
			name: "Main Track",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		});
		expect(created.tracks.order).toEqual([created.tracks.main.id]);
		expect(host.project().currentSceneId).toBe(before.currentSceneId);
		await host.editor.scenes.renameScene({ sceneId, name: "Opening" });
		await host.editor.scenes.switchToScene({ sceneId });
		const edited = host.manager.captureProjectSnapshot()!;
		await expect(
			host.editor.scenes.deleteScene({ sceneId: "main-scene" }),
		).rejects.toThrow("Cannot delete main scene");
		expect(host.manager.captureProjectSnapshot()).toEqual(edited);
		await host.editor.scenes.deleteScene({ sceneId });
		expect(host.project().currentSceneId).toBe("main-scene");
		expect(
			withoutSceneTimestamps(host.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(before));
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(edited);
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		host.manager.detachCanonical();
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		const reopenedRuntime = await createCanonicalTestRuntime();
		await reopened.manager.enableCanonical({ runtime: reopenedRuntime });
		reopened.manager.redo();
		expect(reopened.project().currentSceneId).toBe("main-scene");
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(edited);
		assertCoherent({ host: reopened, runtime: reopenedRuntime });
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();

		const agentHost = createHost();
		await agentHost.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const run = await agentHost.manager.startEditingAgent({
			runId: "scene-authoring",
			request: "צור סצנת פתיחה ושנה את שמה",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Edit scenes", status: "inProgress" }],
		});
		for (const id of [
			"project.classic.scenes.edit",
			"project.classic.scene.delete",
		]) {
			expect(
				JSON.stringify(
					agentHost.manager.executeEditingAgentCommand({
						type: "discover",
						query: "Classic scene",
						limit: 50,
					}),
				),
			).toContain(id);
			agentHost.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: run.epoch,
				id,
			});
		}
		for (const [index, change] of [
			{
				type: "create",
				sceneId,
				mainTrackId: created.tracks.main.id,
				name: "סצנת פתיחה",
				isMain: false,
			},
			{ type: "rename", sceneId, name: "Opening" },
			{ type: "select", sceneId },
		].entries()) {
			agentHost.manager.executeEditingAgentCommand({
				type: "invoke",
				epoch: agentHost.manager.getEditingAgentSnapshot()!.epoch,
				callId: `scene-${index}`,
				id: "project.classic.scenes.edit",
				input: { change },
			});
		}
		expect(
			withoutSceneTimestamps(agentHost.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(edited));
		agentHost.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agentHost.manager.getEditingAgentSnapshot()!.epoch,
			callId: "delete-scene",
			id: "project.classic.scene.delete",
			input: { sceneId },
		});
		expect(
			withoutSceneTimestamps(agentHost.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(before));
		await agentHost.manager.flushHistory();
		agentHost.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"project settings share agent/UI state, coalesce preview history and preserve reopened undo",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		const settings = {
			canvasSize: { width: 1080, height: 1920 },
			fps: { numerator: 60_000, denominator: 1001 },
			canvasSizeMode: "preset" as const,
			originalCanvasSize: { width: 1920, height: 1080 },
			lastCustomCanvasSize: null,
			background: { type: "color" as const, color: "#0d0d0d" },
		};
		host.manager.updateClassicSettings({ settings });
		const edited = host.manager.captureProjectSnapshot()!;
		expect(edited.settings).toEqual({ ...before.settings, ...settings });
		assertCoherent({ host, runtime });
		for (const color of ["#111111", "#222222", "#333333"]) {
			host.manager.updateClassicSettings({
				settings: { background: { type: "color", color } },
				pushHistory: false,
			});
		}
		host.manager.updateClassicSettings({
			settings: { background: { type: "color", color: "#333333" } },
		});
		const previewed = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(edited);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(previewed);
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		host.manager.detachCanonical();
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(edited);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();

		const agentHost = createHost();
		await agentHost.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		const run = await agentHost.manager.startEditingAgent({
			runId: "project-format",
			request: "שנה לפורמט אנכי, רקע כהה ו-60 FPS",
		});
		expect(
			JSON.stringify(
				agentHost.manager.executeEditingAgentCommand({
					type: "discover",
					query: "Classic settings",
					limit: 50,
				}),
			),
		).toContain("project.classic.settings.update");
		agentHost.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "project.classic.settings.update",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Change format", status: "inProgress" }],
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "format",
			id: "project.classic.settings.update",
			input: { settings },
		});
		expect(
			withoutSceneTimestamps(agentHost.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(edited));
		await agentHost.manager.flushHistory();
		agentHost.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"settings gestures stop coalescing across edits and compound settings failures roll back",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		host.manager.updateClassicSettings({
			settings: { background: { type: "color", color: "#123456" } },
			pushHistory: false,
		});
		await host.editor.scenes.renameScene({
			sceneId: "main-scene",
			name: "Intervening rename",
		});
		const renamed = host.manager.captureProjectSnapshot()!;
		host.manager.updateClassicSettings({
			settings: { background: { type: "color", color: "#654321" } },
			pushHistory: false,
		});
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(renamed);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.updateClassicSettings({
						settings: { canvasSize: { width: 1000, height: 1000 } },
						pushHistory: false,
					});
					host.manager.updateClassicSettings({
						settings: { fps: { numerator: 30, denominator: 0 } },
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(renamed);
		host.manager.executeTransaction({
			execute: () => {
				host.manager.updateClassicSettings({
					settings: { canvasSize: { width: 1000, height: 1000 } },
					pushHistory: false,
				});
				host.manager.updateClassicSettings({
					settings: { fps: { numerator: 25, denominator: 1 } },
					pushHistory: false,
				});
			},
		});
		const compound = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(renamed);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(compound);
		host.manager.updateClassicSettings({
			settings: { background: { type: "color", color: "#abcdef" } },
			pushHistory: false,
		});
		const colorPreview = host.manager.captureProjectSnapshot()!;
		host.manager.updateClassicSettings({
			settings: { fps: { numerator: 24, denominator: 1 } },
		});
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(colorPreview);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(compound);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"bookmark UI uses the existing frame and duplicate semantics at fractional and non-grid rates",
	async () => {
		for (const fps of [
			{ numerator: 30_000, denominator: 1001 },
			{ numerator: 24, denominator: 1 },
			{ numerator: 29, denominator: 1 },
		]) {
			const host = createHost();
			host.project().settings.fps = fps;
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const time = (ticks: number) => mediaTime({ ticks });
			const frame = (ticks: number) => getFrameTime({ time: time(ticks), fps });
			let expected = [
				{
					time: frame(4100),
					note: "first",
					duration: time(8008),
					color: "#abcdef",
					groupId: "takes",
				},
				{ time: frame(7900), note: "second" },
				{ time: frame(7900), note: "third" },
			] as import("@/timeline/types").Bookmark[];
			host.manager.editClassicBookmarks({
				sceneId: "main-scene",
				change: { type: "replace", bookmarks: expected },
			});
			await host.editor.scenes.moveBookmark({
				fromTime: time(4100),
				toTime: time(7900),
			});
			expected = moveBookmarkInArray({
				bookmarks: expected,
				fromTime: frame(4100),
				toTime: frame(7900),
			});
			expect(host.project().scenes[0].bookmarks).toEqual(expected);
			await host.editor.scenes.updateBookmark({
				time: time(7900),
				updates: { note: "שלום", duration: undefined, color: undefined },
			});
			expected = JSON.parse(
				JSON.stringify(
					updateBookmarkInArray({
						bookmarks: expected,
						frameTime: frame(7900),
						updates: { note: "שלום", duration: undefined, color: undefined },
					}),
				),
			);
			expect(host.project().scenes[0].bookmarks).toEqual(expected);
			await host.editor.scenes.toggleBookmark({ time: time(7900) });
			expected = toggleBookmarkInArray({
				bookmarks: expected,
				frameTime: frame(7900),
			});
			expect(host.project().scenes[0].bookmarks).toEqual(expected);
			const beforeRemove = host.manager.captureProjectSnapshot();
			await host.editor.scenes.removeBookmark({ time: time(7900) });
			expected = removeBookmarkFromArray({
				bookmarks: expected,
				frameTime: frame(7900),
			});
			expect(host.project().scenes[0].bookmarks).toEqual(expected);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(beforeRemove);
			host.manager.redo();
			expect(host.project().scenes[0].bookmarks).toEqual(expected);
			assertCoherent({ host, runtime });
			await host.manager.flushHistory();
			host.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"agent bookmark edits match the UI and scene plus bookmark compound failures roll back",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		await host.editor.scenes.toggleBookmark({
			time: mediaTime({ ticks: 8000 }),
		});
		const fromUi = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		const run = await host.manager.startEditingAgent({
			runId: "bookmark-authoring",
			request: "הוסף סימנייה",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Mark a frame", status: "inProgress" }],
		});
		expect(
			JSON.stringify(
				host.manager.executeEditingAgentCommand({
					type: "discover",
					query: "bookmark",
					limit: 20,
				}),
			),
		).toContain("timeline.classic.bookmarks.edit");
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "timeline.classic.bookmarks.edit",
		});
		host.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "toggle-bookmark",
			id: "timeline.classic.bookmarks.edit",
			input: { sceneId: "main-scene", change: { type: "toggle", time: 8000 } },
		});
		expect(
			withoutSceneTimestamps(host.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(fromUi));
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicScene({
						type: "create",
						sceneId: "temporary-scene",
						mainTrackId: "temporary-main",
						name: "Temporary",
						isMain: false,
					});
					host.manager.editClassicBookmarks({
						sceneId: "temporary-scene",
						change: {
							type: "replace",
							bookmarks: [{ time: mediaTime({ ticks: -1 }) }],
						},
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"canonical add and reorder match existing Classic placement for every track type",
	async () => {
		const host = createHost();
		host.project().scenes[0].tracks.order = [
			"video-track",
			"missing",
			"titles",
			"video-track",
		];
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		for (const [position, trackType] of (
			[
				"audio",
				"text",
				"video",
				"graphic",
				"effect",
				"parallax",
			] satisfies TrackType[]
		).entries()) {
			const before = host.manager.captureProjectSnapshot()!;
			const trackId = `layout-${trackType}`;
			const index = position % 2 === 0 ? undefined : 1;
			const expected = splitTrackByType({
				tracks: before.scenes[0].tracks,
				track: {
					...buildEmptyTrack({ id: trackId, type: trackType }),
					keepEmpty: true,
				},
				insertIndex:
					index ??
					getDefaultInsertIndexForTrack({
						tracks: before.scenes[0].tracks,
						trackType,
					}),
			});
			host.manager.editClassicTrackLayout({
				type: "add",
				trackId,
				trackType,
				index,
			});
			expect(host.project().scenes[0].tracks).toEqual(expected);
			const after = host.manager.captureProjectSnapshot();
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
		}
		for (const toIndex of [0, 999, -5, 2]) {
			const tracks = host.project().scenes[0].tracks;
			const expected = withReorderedTrack({
				tracks,
				trackId: "video-track",
				toIndex,
			});
			host.manager.editClassicTrackLayout({
				type: "reorder",
				trackId: "video-track",
				toIndex,
			});
			expect(host.project().scenes[0].tracks).toEqual(expected);
		}
		const retained = structuredClone(host.project().scenes[0].tracks);
		host.manager.registerReactor(() => {
			host.editor.scenes.updateSceneTracks({
				tracks: pruneEmptyElementTracks({
					tracks: host.project().scenes[0].tracks,
				}),
			});
		});
		host.manager.execute({
			command: new Rename({ host, name: "Keep explicit tracks" }),
		});
		expect(host.project().scenes[0].tracks).toEqual(retained);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"agent track creation matches UI placement and compound creation rolls back on invalid edits",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		const change = {
			type: "add" as const,
			trackId: "agent-track",
			trackType: "audio" as const,
			name: "מוזיקה",
		};
		host.manager.editClassicTrackLayout(change);
		const fromUi = host.manager.captureProjectSnapshot();
		host.manager.undo();
		const agent = await host.manager.startEditingAgent({
			runId: "layout-agent",
			request: "הוסף ערוץ מוזיקה",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [{ title: "Add the audio track", status: "inProgress" }],
		});
		expect(
			JSON.stringify(
				host.manager.executeEditingAgentCommand({
					type: "discover",
					query: "add track",
					limit: 20,
				}),
			),
		).toContain("timeline.classic.tracks.layout");
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.tracks.layout",
		});
		host.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "add-audio",
			id: "timeline.classic.tracks.layout",
			input: { sceneId: "main-scene", change },
		});
		expect(host.manager.captureProjectSnapshot()).toEqual(fromUi);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.editClassicTrackLayout(change);
					host.manager.editClassicTrackLayout({
						type: "add",
						trackId: "text-1",
						trackType: "text",
					});
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"track UI controls and agent discovery share the same lossless capability and persistent undo",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot();
		host.manager.executeTransaction({
			execute: () => {
				host.manager.updateClassicTrack({
					trackId: "video-track",
					change: { type: "toggleMute" },
				});
				host.manager.updateClassicTrack({
					trackId: "video-track",
					change: { type: "toggleVisibility" },
				});
			},
		});
		const viaUi = host.manager.captureProjectSnapshot();
		expect(viaUi!.scenes[0].tracks.main).toMatchObject({
			muted: true,
			hidden: true,
		});
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		const agent = await host.manager.startEditingAgent({
			runId: "track-controls",
			request: "השתק והסתר את ערוץ הווידאו",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [{ title: "Mute and hide the video track", status: "inProgress" }],
		});
		const discovered = host.manager.executeEditingAgentCommand({
			type: "discover",
			query: "mute track",
			limit: 20,
		});
		expect(JSON.stringify(discovered)).toContain(
			"timeline.classic.track.update",
		);
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.track.update",
		});
		host.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "mute-and-hide",
			id: "timeline.classic.track.update",
			input: {
				sceneId: "main-scene",
				trackId: "video-track",
				change: { type: "set", muted: true, hidden: true },
			},
		});
		expect(host.manager.captureProjectSnapshot()).toEqual(viaUi);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		const reopened = createHost({
			project: structuredClone(host.project()),
			media: host.media(),
		});
		host.manager.detachCanonical();
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(viaUi);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"invalid track control rolls back an entire compound UI action",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = runtime.snapshot();
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					host.manager.updateClassicTrack({
						trackId: "video-track",
						change: { type: "toggleMute" },
					});
					host.manager.updateClassicTrack({
						trackId: "titles",
						change: { type: "set", name: "Must roll back", muted: true },
					});
				},
			}),
		).toThrow();
		expect(runtime.snapshot()).toEqual(before);
		expect(host.manager.canUndo()).toBe(false);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"silence transactions validate host changes before publication and keep one undo boundary",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = runtime.snapshot();
		const tracks = host.editor.scenes.getActiveScene().tracks;
		const next = {
			...tracks,
			main: {
				...tracks.main,
				elements: tracks.main.elements.map((element) => ({
					...element,
					duration: mediaTime({ ticks: element.duration - 120_000 }),
					trimEnd: mediaTime({ ticks: element.trimEnd + 120_000 }),
				})),
			},
		};
		const observed: unknown[] = [];
		const unsubscribe = host.subscribeViews(() => {
			const canonical = runtime.snapshot() as {
				project: { classic: CanonicalClassicSnapshot };
			};
			observed.push(canonical.project.classic.document.scenes[0].tracks);
			expect(canonical.project.classic.document.scenes[0].tracks).toEqual(
				host.project().scenes[0].tracks,
			);
		});
		host.manager.executeSilenceTransaction({
			operation: "smart-remove",
			execute: () => host.editor.scenes.updateSceneTracks({ tracks: next }),
		});
		unsubscribe();
		expect(observed.length).toBeGreaterThan(0);
		const after = runtime.snapshot() as {
			project: { classic: CanonicalClassicSnapshot };
		};
		expect(after.project.classic.document.scenes[0].tracks).toEqual(next);
		host.manager.undo();
		expect((runtime.snapshot() as typeof after).project).toEqual(
			(before as typeof after).project,
		);
		expect(host.manager.canUndo()).toBe(false);
		host.manager.redo();
		expect((runtime.snapshot() as typeof after).project).toEqual(after.project);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"silence transactions roll back unrelated edits and release their scoped contract",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = runtime.snapshot();
		const original = host.project().metadata.name;
		expect(() =>
			host.manager.executeSilenceTransaction({
				operation: "repair-captions",
				execute: () =>
					host.editor.project.setActiveProject({
						project: {
							...host.project(),
							metadata: { ...host.project().metadata, name: "Out of scope" },
						},
					}),
			}),
		).toThrow();
		expect(runtime.snapshot()).toEqual(before);
		expect(host.project().metadata.name).toBe(original);
		expect(host.manager.canUndo()).toBe(false);
		host.editor.project.setActiveProject({
			project: {
				...host.project(),
				metadata: { ...host.project().metadata, name: "Ordinary edit" },
			},
		});
		expect(host.project().metadata.name).toBe("Ordinary edit");
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"editing agent uses the live registry and publishes one undoable Classic edit",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = structuredClone(host.project());
		const initial = await host.manager.startEditingAgent({
			runId: "run-visible-edit",
			request: "Rename my film",
		});
		const epoch = initial.epoch;
		expect(JSON.stringify(host.manager.getEditingAgentModelSchema())).toContain(
			"discover",
		);
		expect(() =>
			host.manager.executeEditingAgentModelAction({
				epoch,
				callId: "fake-verification",
				action: { action: "verify", revision: initial.revision, issues: [] },
			}),
		).toThrow();
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch,
			id: "project.classic.commit",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch,
			steps: [{ title: "Rename and verify", status: "inProgress" }],
		});
		const canonical = runtime.snapshot() as {
			project: { classic: CanonicalClassicSnapshot };
		};
		canonical.project.classic.document.metadata.name = "Agent edited this film";
		host.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch,
			callId: "rename-1",
			id: "project.classic.commit",
			input: { classic: canonical.project.classic },
		});
		expect(host.project().metadata.name).toBe("Agent edited this film");
		assertCoherent({ host, runtime });
		const edited = host.manager.getEditingAgentSnapshot()!;
		expect(edited.receipts).toHaveLength(1);
		expect(edited.receipts[0].committed).toBe(true);
		expect(edited.phase).toBe("needsVerification");
		expect(() =>
			host.manager.executeEditingAgentCommand({
				type: "finish",
				epoch: edited.epoch,
				text: "Done",
			}),
		).toThrow();
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: edited.epoch,
			steps: [{ title: "Rename and verify", status: "complete" }],
		});
		host.manager.verifyEditingAgent({
			epoch: edited.epoch,
			revision: edited.revision!,
			issues: [],
		});
		host.manager.executeEditingAgentCommand({
			type: "finish",
			epoch: edited.epoch,
			text: "Renamed the film",
		});
		expect(host.manager.getEditingAgentSnapshot()!.phase).toBe("completed");
		await host.manager.flushHistory();
		expect(saved!.canonicalArchive!.undoStack).toHaveLength(1);
		host.manager.undo();
		expect(host.project().metadata.name).toBe(before.metadata.name);
		expect(host.manager.canUndo()).toBe(false);
		host.manager.redo();
		expect(host.project().metadata.name).toBe("Agent edited this film");
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"public conversation survives atomic save/reopen without changing editor history",
	async () => {
		const source = createHost();
		let bundle: EditorSessionBundle | null = null;
		await source.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		const before = source.manager.captureProjectSnapshot();
		const revision = source.manager.getStateRevision();
		source.manager.applyEditingConversation({
			type: "user",
			text: "ערוך את הווידאו",
		});
		source.manager.applyEditingConversation({ type: "round", review: false });
		source.manager.applyEditingConversation({
			type: "text",
			text: "Checking the title",
		});
		source.manager.applyEditingConversation({
			type: "summary",
			text: "Checking layout",
		});
		expect(source.manager.getStateRevision()).toBe(revision);
		expect(source.manager.captureProjectSnapshot()).toEqual(before);
		await source.manager.persistEditingSession();
		expect(bundle!.conversation!.entries).toHaveLength(2);
		source.manager.detachCanonical();
		const reopened = createHost();
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		expect(reopened.manager.getEditingConversation()!.entries[0].text).toBe(
			"ערוך את הווידאו",
		);
		expect(reopened.manager.getEditingConversation()!.entries[1]).toMatchObject(
			{
				text: "Checking the title",
				summary: "Checking layout",
				interrupted: true,
			},
		);
		expect(reopened.manager.getEditingConversation()!.activeRound).toBeNull();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.detachCanonical();
		const bad = structuredClone(bundle!);
		bad.conversation!.accountId = "foreign";
		const foreign = createHost();
		await expect(
			foreign.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
				atomicBundle: bad,
				persistSession: async () => {},
			}),
		).rejects.toThrow();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"pinned generated image commits its exact artifact reference and survives paired reopening",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		let bundle: EditorSessionBundle | null = null;
		await host.manager.enableCanonical({
			runtime,
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		const run = await host.manager.startEditingAgent({
			runId: "pinned-image",
			request: "Generate one PNG",
		});
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "imagegen.generate",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Generate and verify", status: "inProgress" }],
		});
		const request = host.manager.prepareEditingAgentRequest("fixture-model");
		const pending = host.manager.applyEditingAgentResponse({
			epoch: request.epoch,
			response: {
				id: "image-response",
				status: "completed",
				output: [
					{
						type: "function_call",
						call_id: "image-call",
						name: "opencut_editor",
						arguments: JSON.stringify({
							action: "invoke",
							id: "imagegen.generate",
							input: {
								operationId: "pinned-operation",
								title: "PNG",
								prompt: "One circle",
							},
						}),
					},
				],
			},
		});
		if (!pending.pendingHost) throw new Error("Image host did not suspend");
		const png = Uint8Array.from(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
				"base64",
			),
		);
		const artifact = host.manager.storeEditingAgentImage({
			bytes: png,
			width: 1,
			height: 1,
		});
		expect(artifact).toMatchObject({
			mimeType: "image/png",
			width: 1,
			height: 1,
			expiresAtMs: Number.MAX_SAFE_INTEGER,
		});
		const settled = host.manager.settleEditingAgentHostEffect({
			effectId: pending.pendingHost.id,
			result: {
				type: "success",
				data: {
					projectId: host.project().metadata.id,
					operationId: "pinned-operation",
					mediaId: "pinned-generated-image",
					fileName: "pinned-image.png",
					lastModified: 123,
					artifact,
				},
			},
		});
		expect(settled.activities[0].ok).toBe(true);
		expect(
			host.manager.getEditingAgentSnapshot()!.receipts.at(-1)?.committed,
		).toBe(true);
		const generated = runtime.invokeSync(
			"app.state.read",
			{ pointer: "/project/classic/mediaAssets" },
			null,
		).result.data.value;
		expect(JSON.stringify(generated)).toContain("pinned-generated-image");
		assertCoherent({ host, runtime });
		await host.manager.persistEditingSession();
		host.manager.detachCanonical();
		const reopened = createHost();
		const fresh = await createCanonicalTestRuntime();
		await reopened.manager.enableCanonical({
			runtime: fresh,
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		expect(
			fresh.invokeSync(
				"app.state.read",
				{ pointer: "/project/classic/mediaAssets" },
				null,
			).result.data.value,
		).toEqual(generated);
		const imageRef = artifact as { id: string };
		expect(
			reopened.manager.readEditingConversationArtifact(imageRef.id).bytes,
		).toEqual(png);
		reopened.manager.undo();
		expect(JSON.stringify(fresh.snapshot())).not.toContain(
			"pinned-generated-image",
		);
		reopened.manager.redo();
		expect(
			fresh.invokeSync(
				"app.state.read",
				{ pointer: "/project/classic/mediaAssets" },
				null,
			).result.data.value,
		).toEqual(generated);
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"conversation export bytes recover by stable artifact identity after reopening",
	async () => {
		const source = createHost();
		let bundle: EditorSessionBundle | null = null;
		await source.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		await source.manager.startEditingAgent({
			runId: "artifact-recovery",
			request: "Export the test video",
		});
		const bytes = new Uint8Array(
			readFileSync(
				new URL(
					"../../../../../../../resources/hyperframes/evidence/composed-export/mixed-export.webm",
					import.meta.url,
				),
			),
		);
		const artifact = source.manager.storeEditingAgentRender({
			bytes,
			mimeType: "video/webm",
		});
		source.manager.applyEditingConversation({
			type: "export",
			artifactId: artifact.id,
			filename: "saved.webm",
		});
		await source.manager.persistEditingSession();
		expect(bundle!.artifacts!.archive.items[0].metadata.id).toBe(artifact.id);
		source.manager.detachCanonical();
		const target = createHost();
		await target.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		const restored = target.manager.readEditingConversationArtifact(
			artifact.id,
		);
		expect(restored.mimeType).toBe("video/webm");
		expect(restored.bytes).toEqual(bytes);
		expect(
			target.manager.getEditingConversation()!.entries.at(-1)!.export!
				.artifactId,
		).toBe(artifact.id);
		target.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"attached inputs remain scoped and readable after paired session recovery",
	async () => {
		const source = createHost();
		let bundle: EditorSessionBundle | null = null;
		await source.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		const bytes = new TextEncoder().encode(
			"שלום: edit according to this brief",
		);
		const file = source.manager.storeEditingAttachment({
			filename: "brief.txt",
			bytes,
			mimeType: "text/plain",
		});
		source.manager.applyEditingConversation({
			type: "user",
			text: "Use the attached brief",
			attachments: [file],
		});
		await source.manager.startEditingAgent({
			runId: "attached-input",
			request: "Use the attached brief",
		});
		source.manager.setEditingInputAttachments([file]);
		expect(
			JSON.stringify(
				source.manager.prepareEditingAgentRequest("test-model").body,
			),
		).toContain("שלום: edit according");
		await source.manager.persistEditingSession();
		source.manager.detachCanonical();
		const target = createHost();
		await target.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		expect(
			target.manager.getEditingConversation()!.entries[0].attachments,
		).toEqual([file]);
		expect(
			target.manager.readEditingConversationArtifact(file.artifactId).bytes,
		).toEqual(bytes);
		expect(() =>
			target.manager.storeEditingAttachment({
				filename: "fake.png",
				bytes,
				mimeType: "image/png",
			}),
		).toThrow();
		target.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"atomic session restore publishes its saved document and paused run without mixing a stale host view",
	async () => {
		const source = createHost();
		let bundle: EditorSessionBundle | null = null;
		const persistSession = async (capture: () => EditorSessionBundle) => {
			bundle = structuredClone(capture());
		};
		const runtime = await createCanonicalTestRuntime();
		await source.manager.enableCanonical({ runtime, persistSession });
		const originalName = source.project().metadata.name;
		const run = await source.manager.startEditingAgent({
			runId: "atomic-run",
			request: "Rename this film",
		});
		source.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "project.classic.commit",
		});
		source.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Rename", status: "inProgress" }],
		});
		const classic = runtime.snapshot().project.classic;
		classic.document.metadata.name = "Saved as one session";
		source.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "rename",
			id: "project.classic.commit",
			input: { classic },
		});
		await source.manager.persistEditingSession();
		expect(bundle).not.toBeNull();
		expect(saved).toBeNull();
		const reopeningBundle = structuredClone(bundle!);
		source.manager.detachCanonical();
		const reopened = createHost();
		const freshRuntime = await createCanonicalTestRuntime();
		await reopened.manager.enableCanonical({
			runtime: freshRuntime,
			atomicBundle: reopeningBundle,
			persistSession,
		});
		expect(reopened.project().metadata.name).toBe("Saved as one session");
		expect(freshRuntime.snapshot().revision).toBe(
			reopeningBundle.archive.revision,
		);
		expect(reopened.manager.getEditingAgentSnapshot()).toMatchObject({
			phase: "paused",
			receipts: [{ committed: true }],
		});
		reopened.manager.undo();
		expect(reopened.project().metadata.name).toBe(originalName);
		await reopened.manager.flushHistory();
		expect(saved).toBeNull();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"atomic save rejection remains observable to exit and agent persistence callers",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		let reject = true;
		await host.manager.enableCanonical({
			runtime,
			persistSession: async (capture) => {
				capture();
				if (reject) throw new Error("Host ownership was transferred");
			},
		});
		await expect(host.manager.flushHistory()).rejects.toThrow("ownership");
		await expect(host.manager.persistEditingSession()).rejects.toThrow(
			"ownership",
		);
		reject = false;
		await host.manager.persistEditingSession();
		await host.manager.flushHistory();
		expect(saved).toBeNull();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

// Five provider rounds plus artifact review exercise the real WASM, not a fast unit stub.
test(
	"streamed provider loop edits the real WASM project, reviews artifacts and completes",
	async () => {
		const { EditorAgentClient } = await import("@/editor-agent/client");
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				__opencutAccountId: "local",
				location: { origin: "http://127.0.0.1:3100" },
			},
		});
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const classic = (
			runtime.snapshot() as { project: { classic: CanonicalClassicSnapshot } }
		).project.classic;
		classic.document.metadata.name = "Streamed provider edit";
		Object.defineProperty(host.editor, "renderer", {
			value: {
				capturePreviewFrameAt: async () => ({
					success: true,
					blob: new Blob(
						[
							new Uint8Array(
								readFileSync(
									new URL(
										"../../../../../../../crates/editor-agent/tests/fixtures/color-frame.jpg",
										import.meta.url,
									),
								),
							),
						],
						{
							type: "image/jpeg",
						},
					),
					filename: "test.jpg",
				}),
			},
		});
		const actions = [
			{ action: "describe", id: "project.classic.commit" },
			{
				action: "plan",
				steps: [{ title: "Rename and verify", status: "inProgress" }],
			},
			{ action: "invoke", id: "project.classic.commit", input: { classic } },
			{
				action: "plan",
				steps: [{ title: "Rename and verify", status: "complete" }],
			},
			{
				action: "complete",
				text: "Renamed the film and reviewed the samples.",
			},
		];
		let calls = 0,
			reviews = 0;
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (url, init) => {
				if (String(url).endsWith("/knowledge"))
					return knowledgeFixtureResponse();
				const request = JSON.parse(String(init?.body));
				if (request.tools.length)
					expect(JSON.stringify(request)).toContain("Keep titles short");
				const review = request.tools.length === 0;
				let output: unknown[];
				if (review) {
					reviews += 1;
					expect(JSON.stringify(request)).toContain("data:image/jpeg;base64,");
					output = [
						{
							type: "message",
							content: [
								{
									type: "output_text",
									text: JSON.stringify({
										issues: [],
										summary: "Fixture review accepted",
									}),
								},
							],
						},
					];
				} else {
					const action = actions[calls++];
					expect(action).toBeDefined();
					output = [
						{
							type: "function_call",
							name: "opencut_editor",
							call_id: `call-${calls}`,
							arguments: JSON.stringify(action),
						},
					];
				}
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${calls}-${reviews}`, status: "completed", output } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);
		const client = new EditorAgentClient({
			editor: host.editor,
			emit: () => {},
		});
		try {
			await client.run({
				text: "Rename my film",
				model: "scripted-test-provider",
			});
			expect(calls).toBe(5);
			expect(reviews).toBe(1);
			expect(host.manager.getEditingAgentSnapshot()?.phase).toBe("completed");
			expect(host.project().metadata.name).toBe("Streamed provider edit");
			host.manager.undo();
			expect(host.project().metadata.name).toBe("Existing edit");
			await host.manager.flushHistory();
		} finally {
			client.dispose();
			fetchMock.mockRestore();
			host.manager.detachCanonical();
			if (originalWindow === undefined)
				Reflect.deleteProperty(globalThis, "window");
			else
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					value: originalWindow,
				});
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"rapid steering cancels the previous stream and only starts the latest instruction",
	async () => {
		const { EditorAgentClient } = await import("@/editor-agent/client");
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				__opencutAccountId: "local",
				location: { origin: "http://127.0.0.1:3100" },
			},
		});
		const host = createHost(),
			runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		let calls = 0;
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (url, init) => {
				if (String(url).endsWith("/knowledge"))
					return knowledgeFixtureResponse();
				calls += 1;
				if (calls === 1) {
					started();
					return new Promise<Response>((_resolve, reject) =>
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("Stopped", "AbortError")),
							{ once: true },
						),
					);
				}
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: "latest-response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Here is the requested explanation." }] }] } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);
		const client = new EditorAgentClient({
			editor: host.editor,
			emit: () => {},
		});
		try {
			const first = client.run({ text: "Explain this edit", model: "fixture" });
			await ready;
			const second = client.run({
				text: "Second instruction",
				model: "fixture",
			});
			const third = client.run({
				text: "Latest instruction",
				model: "fixture",
			});
			await Promise.all([first, second, third]);
			expect(calls).toBe(2);
			expect(host.manager.getEditingAgentSnapshot()?.steering).toEqual([
				"Latest instruction",
			]);
			expect(host.manager.getEditingAgentSnapshot()?.phase).toBe("completed");
			expect(host.manager.canUndo()).toBe(false);
		} finally {
			client.dispose();
			fetchMock.mockRestore();
			host.manager.detachCanonical();
			if (originalWindow === undefined)
				Reflect.deleteProperty(globalThis, "window");
			else
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					value: originalWindow,
				});
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"client resumes an uncertain host write with the original retry identity",
	async () => {
		const { EditorAgentClient } = await import("@/editor-agent/client");
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { __opencutAccountId: "local" },
		});
		const host = createHost(),
			runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const actions = [
			{ action: "describe", id: "knowledge.change" },
			{
				action: "plan",
				steps: [{ title: "Remember captions", status: "inProgress" }],
			},
			{
				action: "invoke",
				id: "knowledge.change",
				input: {
					expectedKnowledgeRevision: 7,
					change: {
						type: "create",
						key: { kind: "memory", id: "captions" },
						location: { type: "project", projectId: "classic-project" },
						content: {
							title: "Caption preference",
							body: "Use Hebrew captions",
							tags: [],
							enabled: true,
						},
					},
				},
			},
			{
				action: "plan",
				steps: [{ title: "Remember captions", status: "complete" }],
			},
			{ action: "complete", text: "The caption preference is saved." },
		];
		let calls = 0,
			writes = 0,
			firstRequest = "";
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (url, init) => {
				const request = JSON.parse(String(init?.body));
				if (String(url).endsWith("/knowledge")) {
					if (request.request.type === "context") {
						const context = await knowledgeFixtureResponse().json();
						context.revision = context.data.revision = writes ? 8 : 7;
						return Response.json(context);
					}
					if (writes++ === 0) {
						firstRequest = String(init?.body);
						throw new Error("Response lost after commit");
					}
					expect(String(init?.body)).toBe(firstRequest);
					return Response.json({
						revision: 8,
						changed: false,
						data: {
							revision: 8,
							key: { kind: "memory", id: "captions" },
							version: 1,
						},
					});
				}
				expect(request.tools.length).toBe(1); // No render QA for a memory-only change.
				const action = actions[calls++];
				expect(action).toBeDefined();
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: `memory-${calls}`, status: "completed", output: [{ type: "function_call", name: "opencut_editor", call_id: `memory-call-${calls}`, arguments: JSON.stringify(action) }] } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);
		const client = new EditorAgentClient({
			editor: host.editor,
			emit: () => {},
		});
		try {
			await expect(
				client.run({ text: "Remember Hebrew captions", model: "fixture" }),
			).rejects.toThrow("Response lost");
			expect(host.manager.getEditingAgentSnapshot()?.phase).toBe("paused");
			expect(host.manager.getEditingAgentHostEffect()).not.toBeNull();
			await client.run({ model: "fixture" });
			expect(writes).toBe(2);
			expect(calls).toBe(5);
			expect(host.manager.getEditingAgentSnapshot()?.phase).toBe("completed");
			expect(
				host.manager
					.getEditingAgentSnapshot()
					?.receipts.filter((r) => r.capabilityId === "knowledge.change"),
			).toHaveLength(1);
			expect(host.manager.canUndo()).toBe(false);
		} finally {
			client.dispose();
			fetchMock.mockRestore();
			host.manager.detachCanonical();
			if (originalWindow === undefined)
				Reflect.deleteProperty(globalThis, "window");
			else
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					value: originalWindow,
				});
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"editing agent pause and steering fence buffered calls before any visible change",
	async () => {
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const initial = await host.manager.startEditingAgent({
			runId: "run-paused",
			request: "Edit the film",
		});
		const before = structuredClone(host.project());
		host.manager.executeEditingAgentCommand({
			type: "steer",
			text: "Keep everything as it is",
		});
		expect(() =>
			host.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: initial.epoch,
				id: "project.classic.commit",
			}),
		).toThrow();
		host.manager.executeEditingAgentCommand({ type: "pause" });
		expect(host.manager.getEditingAgentSnapshot()!.phase).toBe("paused");
		expect(() =>
			host.manager.executeEditingAgentCommand({
				type: "resume",
				scope: { ...initial.scope, accountId: "another-account" },
			}),
		).toThrow();
		host.manager.executeEditingAgentCommand({
			type: "resume",
			scope: initial.scope,
		});
		host.manager.executeEditingAgentCommand({ type: "observe" });
		expect(host.project()).toEqual(before);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

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

test(
	"source and variable preflight commit through canonical history and survive reopening",
	async () => {
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
			expect(originalSource.files["index.html"]).toBe(
				source.files["index.html"],
			);
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
	},
	INTEGRATION_TIMEOUT,
);

// Each preflight matrix initializes several real WASM registries; keep the
// per-test bound above their aggregate startup cost on a busy development host.
test(
	"source preflight rejects cancellation, account or scene switches, stale revisions and render failures",
	async () => {
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
							"index.html": source.files["index.html"].replace(
								"שלום",
								"Changed",
							),
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"layer move compiles source and commits history, while cancellation and concurrent edits discard preflight",
	async () => {
		const browser = renderFixture();
		const savedParser = Object.getOwnPropertyDescriptor(
			globalThis,
			"DOMParser",
		);
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
			for (const outcome of ["commit", "cancel", "revision", "helper"]) {
				const host = createHost();
				const runtime = await createCanonicalTestRuntime();
				await host.manager.enableCanonical({ runtime });
				const source: HyperframesSource = {
					entryFile: "index.html",
					resourceAssetIds: {},
					files: {
						"index.html": `<div data-composition-id="main" data-width="320" data-height="180" data-duration="6"><div id="paint" data-start="1" data-duration="2"></div></div><script>const tl=gsap.timeline({paused:true});${outcome === "helper" ? "function motion(t){tl.to('#paint',{x:100,duration:2},t)}motion(1);" : "tl.to('#paint',{x:100,duration:2},1);"}window.__timelines={main:tl};</script>`,
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
								startSeconds:
									outcome === "helper" &&
									prepared.files["index.html"].includes(
										"data-opencut-generated-layer-move",
									)
										? 3
										: Number(
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
					expect(checked[0].files["index.html"]).toContain(
						outcome === "helper"
							? "data-opencut-generated-layer-move"
							: "duration:2},3)",
					);
					expect(host.project()).toEqual(before);
					if (outcome === "cancel") controller.abort();
					if (outcome === "revision")
						host.manager.execute({
							command: new Rename({ host, name: "Concurrent rename" }),
						});
					const current = structuredClone(host.project());
					resume.resolve();
					if (outcome === "commit" || outcome === "helper") {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"composition library reuses its canonical source with selection and persistent undo",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"audio projection reads the same canonical clip after host edits and undo",
	async () => {
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
				const scene = project.scenes.find(
					(scene) => scene.id === input.sceneId,
				)!;
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"runtime layers publish through canonical state, undo and persisted history",
	async () => {
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
			host.project().hyperframesCompositions?.[imported.assetId]
				.runtimeManifest,
		).toEqual(manifest);
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(
			host.project().hyperframesCompositions?.[imported.assetId]
				.runtimeManifest,
		).toBeUndefined();
		host.manager.redo();
		expect(
			host.project().hyperframesCompositions?.[imported.assetId]
				.runtimeManifest,
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
	},
	INTEGRATION_TIMEOUT,
);

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

test(
	"real canonical edits and undo/redo reuse HyperFrames browsers and decoded frames",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"adopts live Classic undo, imports into existing scenes and retains selective command behavior",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"scene views publish after validation and keep a valid active scene after deletion",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"folder import preflights bindings and retains durable resource URLs through undo/redo",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"canonical insertion shares agent/UI batches, atomic selection and reopened history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const target = { trackId: "video-track", elementId: "item-2" };
		host.editor.selection.applySelectionPatch({
			patch: { selectedElements: [target] },
		});
		const selected = structuredClone(host.selection());
		const before = host.manager.captureProjectSnapshot()!;
		const clips: import("@/commands/timeline/element/insert-element").InsertElementParams[] =
			[
				{
					element: {
						type: "text",
						name: "New title",
						startTime: mediaTime({ ticks: 120000 }),
						duration: mediaTime({ ticks: 240000 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						params: { content: "כותרת חדשה" },
					},
					placement: { mode: "auto" },
				},
				{
					element: {
						type: "audio",
						sourceType: "library",
						libraryAssetId: "test-sound",
						name: "Sound",
						startTime: mediaTime({ ticks: 120000 }),
						duration: mediaTime({ ticks: 240000 }),
						trimStart: mediaTime({ ticks: 0 }),
						trimEnd: mediaTime({ ticks: 0 }),
						params: { volume: 0.5 },
					},
					placement: { mode: "auto" },
				},
			];
		expect(() =>
			host.manager.insertClassicTimelineElements([
				...clips,
				{
					...clips[0],
					placement: { mode: "explicit", trackId: "video-track" },
				},
			]),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		const directId = timeline.insertElement(clips[0]);
		expect(
			host
				.project()
				.scenes[0].tracks.overlay.flatMap<TimelineElement>(
					(track) => track.elements,
				)
				.find((element) => element.id === directId)?.name,
		).toBe("New title");
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		const refs = host.manager.insertClassicTimelineElements(clips);
		expect(refs.length).toBe(2);
		expect(host.selection().selectedElements).toEqual([refs[1]]);
		const viaUi = host.manager.captureProjectSnapshot()!;
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		expect(host.manager.canUndo()).toBe(false);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(viaUi);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(reopened.selection()).toEqual(selected);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(viaUi);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
		const agentHost = createHost();
		const agentRuntime = await createCanonicalTestRuntime();
		await agentHost.manager.enableCanonical({ runtime: agentRuntime });
		const agent = await agentHost.manager.startEditingAgent({
			runId: "insert-agent",
			request: "הוסף כותרת וצליל לתחילת הסרטון",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [{ title: "Insert title and sound", status: "inProgress" }],
		});
		expect(
			JSON.stringify(
				agentHost.manager.executeEditingAgentCommand({
					type: "discover",
					query: "insert clip",
					limit: 20,
				}),
			),
		).toContain("timeline.classic.elements.insert");
		agentHost.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.elements.insert",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "insert",
			id: "timeline.classic.elements.insert",
			input: { sceneId: "main-scene", clips },
		});
		expect(
			withoutSceneTimestamps(agentHost.manager.captureProjectSnapshot()!),
		).toEqual(withoutSceneTimestamps(viaUi));
		assertCoherent({ host: agentHost, runtime: agentRuntime });
		agentHost.manager.undo();
		expect(agentHost.manager.captureProjectSnapshot()).toEqual(before);
		await agentHost.manager.flushHistory();
		agentHost.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"split UI shares retimed source rounding, curve halves, atomic rollback and reopened history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		host.project().scenes[0].tracks.main.elements[0].animations = {
			opacity: animationFixture().opacity,
		};
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot()!;
		const clip = before.scenes[0].tracks.main.elements[0];
		const rightRefs = timeline.splitElements({
			elements: [{ trackId: "video-track", elementId: "item-2" }],
			splitTime: mediaTime({ ticks: 600001 }),
		});
		const halves = host.project().scenes[0].tracks.main.elements;
		expect(halves).toHaveLength(2);
		expect(halves[0].duration + halves[1].duration).toBe(clip.duration);
		expect(halves[0].trimEnd).toBe(mediaTime({ ticks: 989999 }));
		expect(halves[1].trimStart).toBe(mediaTime({ ticks: 1230001 }));
		expect(rightRefs).toEqual([
			{ trackId: "video-track", elementId: halves[1].id },
		]);
		expect(host.selection().selectedElements).toEqual(rightRefs);
		expect(halves[1].masks).toEqual(clip.masks);
		assertCoherent({ host, runtime });
		const after = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(() =>
			timeline.splitElements({
				elements: [
					{ trackId: "video-track", elementId: "item-2" },
					{ trackId: "video-track", elementId: "missing" },
				],
				splitTime: mediaTime({ ticks: 600000 }),
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"clipboard UI shares scoped snapshots, exact group placement, fresh animation IDs and reopened undo",
	async () => {
		const { ElementsClipboardHandler } =
			await import("@/clipboard/handlers/elements");
		for (const reuse of [false, true]) {
			const host = createHost();
			const original = host.project().scenes[0].tracks.main.elements[0];
			original.animations = { opacity: animationFixture().opacity };
			if (reuse)
				host
					.project()
					.scenes[0].tracks.overlay.unshift(
						buildEmptyTrack({ id: "available-above", type: "video" }),
					);
			if (reuse)
				host.project().scenes[0].tracks.order = [
					"titles",
					"available-above",
					"video-track",
				];
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const before = host.manager.captureProjectSnapshot()!;
			const revision = host.manager.getCanonicalRevision();
			const entry = ElementsClipboardHandler.copy({
				editor: host.editor,
				selectedElements: [{ trackId: "video-track", elementId: "item-2" }],
				selectedKeyframes: [],
			});
			expect(entry?.sourceProjectId).toBe("classic-project");
			expect(host.manager.getCanonicalRevision()).toBe(revision);
			if (!entry) throw new Error("Expected a clip clipboard snapshot");
			expect(entry.items[0].element).not.toHaveProperty("id");
			const placement = resolveTrackPlacement({
				tracks: host.project().scenes[0].tracks,
				trackType: "video",
				timeSpans: [
					{ startTime: mediaTime({ ticks: 7 }), duration: original.duration },
				],
				strategy: { type: "aboveSource", sourceTrackIndex: reuse ? 2 : 1 },
			});
			const operation = ElementsClipboardHandler.paste({
				entry,
				context: {
					editor: host.editor,
					time: mediaTime({ ticks: 7 }),
					selectedElements: [],
					selectedKeyframes: [],
				},
			});
			expect(operation?.executeCanonical()).toBe(true);
			const selected = host.selection().selectedElements[0];
			expect(selected.trackId === "available-above").toBe(
				placement?.kind === "existingTrack",
			);
			const track = host
				.project()
				.scenes[0].tracks.overlay.find((t) => t.id === selected.trackId)!;
			const copy = track.elements[0];
			expect(copy.startTime).toBe(mediaTime({ ticks: 7 }));
			expect(copy.id).not.toBe(original.id);
			const copiedKeys = copy.animations?.opacity?.keys;
			const originalKeys = original.animations?.opacity?.keys;
			if (!Array.isArray(copiedKeys) || !Array.isArray(originalKeys))
				throw new Error("Expected scalar opacity keys");
			expect(copiedKeys[0].id).not.toBe(originalKeys[0].id);
			expect(withoutKeyframeIds(copy)).toEqual(
				withoutKeyframeIds({
					...original,
					id: copy.id,
					startTime: mediaTime({ ticks: 7 }),
					animations: cloneAnimations({
						animations: original.animations,
						shouldRegenerateKeyframeIds: true,
					}),
				}),
			);
			assertCoherent({ host, runtime });
			const after = host.manager.captureProjectSnapshot()!;
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			expect(() =>
				host.manager.pasteClassicTimelineElements({
					time: mediaTime({ ticks: 7 }),
					items: entry.items,
					sourceProjectId: "another-project",
				}),
			).toThrow();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			await host.manager.flushHistory();
			host.manager.detachCanonical();
			const reopened = createHost({
				project: host.project(),
				media: host.media(),
			});
			await reopened.manager.loadHistory({ projectId: "classic-project" });
			await reopened.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
			});
			reopened.manager.undo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"text merge UI matches both legacy word/row modes and keeps transcript ownership with atomic reopened undo",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { mergeTextElements } = await import("@/text/text-layer-utils");
		const {
			removeTextLayerWordsFromCaptionSource,
			syncTextLayerWordsIntoCaptionSource,
		} = await import("@/subtitles/caption-source-sync");
		for (const mode of ["single-line", "multiline"] as const) {
			const host = createHost();
			const titles = host.project().scenes[0].tracks.overlay[0];
			if (titles.type !== "text") throw new Error("Expected text fixture");
			const first = titles.elements[0];
			first.params.content = "שלום";
			first.wordRuns = [
				{
					id: "word-original",
					text: "שלום",
					lineIndex: 0,
					startTime: mediaTime({ ticks: 7 }),
					endTime: mediaTime({ ticks: 100003 }),
					style: { color: "red" },
				},
			];
			first.textRowOverrides = [
				{ id: "row-original", lineIndex: 0, style: { opacity: 0.8 } },
			];
			const second = {
				...structuredClone(first),
				id: "second-text",
				startTime: mediaTime({ ticks: 120003 }),
				params: { ...first.params, content: "עולם הבא" },
				wordRuns: undefined,
			};
			titles.elements.push(second);
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const before = host.manager.captureProjectSnapshot()!;
			const legacy = mergeTextElements({
				items: [
					{ trackId: "titles", element: second },
					{ trackId: "titles", element: first },
				],
				mode,
			});
			if (!legacy) throw new Error("Expected a legacy text merge plan");
			let expected = structuredClone(before.scenes[0].tracks);
			const expectedTitle = expected.overlay[0];
			if (expectedTitle.type !== "text") throw new Error("Expected text track");
			expectedTitle.elements = [legacy.mergedElement];
			const target = {
				trackId: legacy.targetTrackId,
				elementId: legacy.targetElementId,
			};
			expected = removeTextLayerWordsFromCaptionSource({
				tracks: expected,
				elements:
					mode === "multiline"
						? [target, ...legacy.removeElements]
						: legacy.removeElements,
			});
			expected = syncTextLayerWordsIntoCaptionSource({
				tracks: expected,
				elements: [target],
			});
			const timeline = new TimelineManager(host.editor);
			timeline.mergeTextElements({
				elements: [
					{ trackId: "titles", elementId: "second-text" },
					{ trackId: "titles", elementId: "text-1" },
				],
				mode,
			});
			expect(
				JSON.parse(JSON.stringify(host.project().scenes[0].tracks)),
			).toEqual(JSON.parse(JSON.stringify(expected)));
			expect(host.selection().selectedElements).toEqual([target]);
			assertCoherent({ host, runtime });
			const after = host.manager.captureProjectSnapshot()!;
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			expect(() =>
				timeline.mergeTextElements({
					elements: [
						{ trackId: "titles", elementId: "text-1" },
						{ trackId: "titles", elementId: "missing" },
					],
					mode,
				}),
			).toThrow();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			await host.manager.flushHistory();
			host.manager.detachCanonical();
			const reopened = createHost({
				project: host.project(),
				media: host.media(),
			});
			await reopened.manager.loadHistory({ projectId: "classic-project" });
			await reopened.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
			});
			reopened.manager.undo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"background removal UI and registry preserve legacy settings and layer placement policy",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { buildBackgroundRemovalEdit, getDefaultBackgroundRemovalSettings } =
			await import("@/background-removal");
		for (const duplicate of [false, true]) {
			const host = createHost();
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			const timeline = new TimelineManager(host.editor);
			const before = host.manager.captureProjectSnapshot()!;
			const settings = {
				...getDefaultBackgroundRemovalSettings(),
				mode: "blur" as const,
				quality: "precise" as const,
				maskThreshold: 2,
				edgeFeather: 10,
			};
			const target = timeline.setBackgroundRemoval({
				trackId: "video-track",
				elementId: "item-2",
				settings,
				duplicate,
			});
			expect(target).not.toBeNull();
			if (!target) throw new Error("Missing background removal target");
			const expected = buildBackgroundRemovalEdit({
				tracks: before.scenes[0].tracks,
				trackId: "video-track",
				elementId: "item-2",
				settings,
				duplicate,
				duplicateElementId: target.elementId,
				duplicateTrackId: target.trackId,
			});
			expect(expected).not.toBeNull();
			expect(
				withoutKeyframeIds(
					JSON.parse(JSON.stringify(host.project().scenes[0].tracks)),
				),
			).toEqual(
				withoutKeyframeIds(JSON.parse(JSON.stringify(expected!.tracks))),
			);
			assertCoherent({ host, runtime });
			const after = host.manager.captureProjectSnapshot();
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			await host.manager.flushHistory();
			host.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"transition UI matches every shared preset and both edges with atomic rollback and history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { TRANSITION_PRESETS, buildTransitionPatch } =
			await import("@/transitions");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot()!;
		for (const { id } of TRANSITION_PRESETS)
			for (const side of ["in", "out"] as const) {
				const original = before.scenes[0].tracks.main.elements[0];
				const expected = {
					...original,
					...buildTransitionPatch({ element: original, presetId: id, side }),
				};
				timeline.applyTransitions({
					applications: [
						{ trackId: "video-track", elementId: "item-2", presetId: id, side },
					],
				});
				const comparable = (clip: TimelineElement) => {
					const value = JSON.parse(JSON.stringify(clip));
					for (const transition of Object.values(
						value.transitions ?? {},
					) as Array<{ id?: string; createdAt?: string }>) {
						delete transition.id;
						delete transition.createdAt;
					}
					return withoutKeyframeIds(value);
				};
				expect(
					comparable(host.project().scenes[0].tracks.main.elements[0]),
				).toEqual(comparable(expected as TimelineElement));
				host.manager.undo();
				expect(host.manager.captureProjectSnapshot()).toEqual(before);
			}
		const state = host.manager.captureProjectSnapshot();
		expect(() =>
			timeline.applyTransitions({
				applications: [
					{
						trackId: "video-track",
						elementId: "item-2",
						presetId: "fade",
						side: "in",
					},
					{
						trackId: "video-track",
						elementId: "missing",
						presetId: "fade",
						side: "out",
					},
				],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(state);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"clip update UI matches existing trim/retime/curve policy, groups gestures and exposes future params",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const initial = host.project().scenes[0].tracks;
		initial.main.elements[0].animations = {
			opacity: animationFixture().opacity,
		};
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot()!;
		const patches: Array<Partial<TimelineElement>> = [
			{ params: { futureFeature: 0.75 } },
			{ retime: { rate: 2.5, maintainPitch: true } },
			{ retime: undefined },
			{ duration: mediaTime({ ticks: 50 }) },
			{
				trimStart: mediaTime({ ticks: 480010 }),
				duration: mediaTime({ ticks: 600000 }),
			},
		];
		for (const patch of patches) {
			const tracks = structuredClone(before.scenes[0].tracks);
			const expected = applyElementUpdate({
				element: tracks.main.elements[0],
				patch,
				context: { tracks, trackId: "video-track" },
			});
			timeline.updateElements({
				updates: [{ trackId: "video-track", elementId: "item-2", patch }],
			});
			expect(
				withoutKeyframeIds(
					JSON.parse(
						JSON.stringify(host.project().scenes[0].tracks.main.elements[0]),
					),
				),
			).toEqual(withoutKeyframeIds(JSON.parse(JSON.stringify(expected))));
			assertCoherent({ host, runtime });
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
		}
		const afterUndo = host.manager.captureProjectSnapshot();
		expect(() =>
			timeline.updateElements({
				updates: [
					{
						trackId: "video-track",
						elementId: "item-2",
						patch: { name: "Changed" },
					},
					{
						trackId: "video-track",
						elementId: "missing",
						patch: { name: "Missing" },
					},
				],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(afterUndo);
		timeline.updateElements({
			updates: [
				{
					trackId: "video-track",
					elementId: "item-2",
					patch: { params: { futureFeature: 1 } },
				},
			],
			pushHistory: false,
		});
		timeline.updateElements({
			updates: [
				{
					trackId: "video-track",
					elementId: "item-2",
					patch: { params: { futureFeature: 2 } },
				},
			],
			pushHistory: false,
		});
		timeline.updateElements({
			updates: [
				{
					trackId: "video-track",
					elementId: "item-2",
					patch: { params: { futureFeature: 3 } },
				},
			],
		});
		const after = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"move UI and agent share exact ticks, selection, atomic errors and reopened undo",
	async () => {
		const time = (ticks: number) => mediaTime({ ticks });
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const before = host.manager.captureProjectSnapshot()!;
		const moves = [
			{
				sourceTrackId: "video-track",
				elementId: "item-2",
				targetTrackId: "new-video",
				newStartTime: time(120001),
			},
		];
		const createTracks = [
			{ id: "new-video", type: "video" as const, index: 0 },
		];
		const timeline = new TimelineManager(host.editor);
		timeline.moveElements({ moves, createTracks });
		const after = host.manager.captureProjectSnapshot()!;
		expect(host.selection().selectedElements).toEqual([
			{ trackId: "new-video", elementId: "item-2" },
		]);
		expect(
			after.scenes[0].tracks.overlay.find((t) => t.id === "new-video")
				?.elements[0].startTime,
		).toBe(time(120001));
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		expect(() =>
			timeline.moveElements({
				moves: [...moves, { ...moves[0], elementId: "missing" }],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(after);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
		const agentHost = createHost();
		const agentRuntime = await createCanonicalTestRuntime();
		await agentHost.manager.enableCanonical({ runtime: agentRuntime });
		const agent = await agentHost.manager.startEditingAgent({
			runId: "move-agent",
			request: "הזז את הקליפ",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [{ title: "Move clip", status: "inProgress" }],
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.elements.move",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "move",
			id: "timeline.classic.elements.move",
			input: { sceneId: "main-scene", moves, createTracks },
		});
		expect(agentHost.manager.captureProjectSnapshot()).toEqual(after);
		assertCoherent({ host: agentHost, runtime: agentRuntime });
		await agentHost.manager.flushHistory();
		agentHost.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"duplicate UI and discovered agent share clip identities, selection and reopened undo",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		Object.assign(host.project().scenes[0].tracks.main.elements[0], {
			animations: { opacity: animationFixture().opacity },
		});
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const target = { trackId: "video-track", elementId: "item-2" };
		host.editor.selection.applySelectionPatch({
			patch: { selectedElements: [target] },
		});
		const before = host.manager.captureProjectSnapshot()!;
		const selected = structuredClone(host.selection());
		expect(() =>
			timeline.duplicateElements({
				elements: [target, { trackId: "titles", elementId: "missing" }],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		const refs = timeline.duplicateElements({ elements: [target, target] });
		expect(refs.length).toBe(1);
		expect(host.selection().selectedElements).toEqual(refs);
		const viaUi = host.manager.captureProjectSnapshot()!;
		expect(viaUi.scenes[0].tracks.overlay[0].elements[0]).toMatchObject({
			id: refs[0].elementId,
			name: "Original video (copy)",
			mediaId: "video-asset",
		});
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(viaUi);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		const reopenedRuntime = await createCanonicalTestRuntime();
		await reopened.manager.enableCanonical({ runtime: reopenedRuntime });
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(reopened.selection()).toEqual(selected);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(viaUi);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
		const agentHost = createHost();
		Object.assign(agentHost.project().scenes[0].tracks.main.elements[0], {
			animations: { opacity: animationFixture().opacity },
		});
		const agentRuntime = await createCanonicalTestRuntime();
		await agentHost.manager.enableCanonical({ runtime: agentRuntime });
		const agent = await agentHost.manager.startEditingAgent({
			runId: "duplicate-agent",
			request: "שכפל את קליפ הווידאו לשכבה חדשה",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [{ title: "Duplicate the video clip", status: "inProgress" }],
		});
		expect(
			JSON.stringify(
				agentHost.manager.executeEditingAgentCommand({
					type: "discover",
					query: "duplicate clip",
					limit: 20,
				}),
			),
		).toContain("timeline.classic.elements.duplicate");
		agentHost.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.elements.duplicate",
		});
		agentHost.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "duplicate",
			id: "timeline.classic.elements.duplicate",
			input: { sceneId: "main-scene", elements: [target, target] },
		});
		expect(agentHost.manager.captureProjectSnapshot()).toEqual(viaUi);
		assertCoherent({ host: agentHost, runtime: agentRuntime });
		agentHost.manager.undo();
		expect(agentHost.manager.captureProjectSnapshot()).toEqual(before);
		expect(() =>
			agentHost.manager.executeTransaction({
				execute: () => {
					agentHost.manager.duplicateClassicTimelineElements([target]);
					agentHost.manager.duplicateClassicTimelineElements([
						{ trackId: "titles", elementId: "missing" },
					]);
				},
			}),
		).toThrow();
		expect(agentHost.manager.captureProjectSnapshot()).toEqual(before);
		await agentHost.manager.flushHistory();
		agentHost.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"clip mute/visibility gestures and discovered agent share state and reopened undo",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const elements = [
			{ trackId: "video-track", elementId: "item-2" },
			{ trackId: "titles", elementId: "text-1" },
		];
		for (const type of ["toggleMute", "toggleVisibility"] as const) {
			const host = createHost();
			const runtime = await createCanonicalTestRuntime();
			await host.manager.enableCanonical({ runtime });
			host.editor.selection.applySelectionPatch({
				patch: { selectedElements: elements },
			});
			const before = host.manager.captureProjectSnapshot()!;
			const selected = structuredClone(host.selection());
			const timeline = new TimelineManager(host.editor);
			if (type === "toggleMute") timeline.toggleElementsMuted({ elements });
			else timeline.toggleElementsVisibility({ elements });
			const viaUi = host.manager.captureProjectSnapshot()!;
			expect(host.selection()).toEqual(selected);
			assertCoherent({ host, runtime });
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(viaUi);
			await host.manager.flushHistory();
			host.manager.detachCanonical();
			const reopened = createHost({
				project: host.project(),
				media: host.media(),
			});
			await reopened.manager.loadHistory({ projectId: "classic-project" });
			await reopened.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
			});
			reopened.manager.undo();
			expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
			expect(reopened.selection()).toEqual(selected);
			await reopened.manager.flushHistory();
			reopened.manager.detachCanonical();
			const agentHost = createHost();
			const agentRuntime = await createCanonicalTestRuntime();
			await agentHost.manager.enableCanonical({ runtime: agentRuntime });
			const agent = await agentHost.manager.startEditingAgent({
				runId: `clip-controls-${type}`,
				request: "שנה את בקרות הקליפים שנבחרו",
			});
			agentHost.manager.executeEditingAgentCommand({
				type: "plan",
				epoch: agent.epoch,
				steps: [
					{ title: "Update selected clip controls", status: "inProgress" },
				],
			});
			expect(
				JSON.stringify(
					agentHost.manager.executeEditingAgentCommand({
						type: "discover",
						query: "mute hide clip",
						limit: 20,
					}),
				),
			).toContain("timeline.classic.elements.controls");
			agentHost.manager.executeEditingAgentCommand({
				type: "describe",
				epoch: agent.epoch,
				id: "timeline.classic.elements.controls",
			});
			agentHost.manager.executeEditingAgentCommand({
				type: "invoke",
				epoch: agent.epoch,
				callId: type,
				id: "timeline.classic.elements.controls",
				input: { sceneId: "main-scene", elements, change: { type } },
			});
			expect(agentHost.manager.captureProjectSnapshot()).toEqual(viaUi);
			assertCoherent({ host: agentHost, runtime: agentRuntime });
			agentHost.manager.undo();
			expect(agentHost.manager.captureProjectSnapshot()).toEqual(before);
			expect(() =>
				agentHost.manager.executeTransaction({
					execute: () => {
						agentHost.manager.editClassicElementControls({
							elements,
							change: { type },
						});
						agentHost.manager.editClassicElementControls({
							elements: [{ trackId: "titles", elementId: "missing" }],
							change: { type },
						});
					},
				}),
			).toThrow();
			expect(agentHost.manager.captureProjectSnapshot()).toEqual(before);
			await agentHost.manager.flushHistory();
			agentHost.manager.detachCanonical();
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"parallax UI and discovered agent share clamping, atomic failure and reopened history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		host.manager.editClassicTrackLayout({
			type: "add",
			trackId: "depth",
			trackType: "parallax",
		});
		const before = host.manager.captureProjectSnapshot()!;
		for (const speed of [-20, 37.5, 800]) {
			timeline.updateParallaxTrack({
				trackId: "depth",
				direction: "with-camera",
				speedPercent: speed,
			});
			const expected = structuredClone(before);
			Object.assign(expected.scenes[0].tracks.overlay[0], {
				direction: "with-camera",
				speedPercent: Math.max(0, Math.min(400, speed)),
			});
			expect(host.manager.captureProjectSnapshot()).toEqual(expected);
			assertCoherent({ host, runtime });
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
		}
		expect(() =>
			host.manager.executeTransaction({
				execute: () => {
					timeline.updateParallaxTrack({ trackId: "depth", speedPercent: 200 });
					timeline.updateParallaxTrack({ trackId: "titles", speedPercent: 50 });
				},
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		timeline.updateParallaxTrack({
			trackId: "depth",
			direction: "with-camera",
			speedPercent: 850,
		});
		const viaUi = host.manager.captureProjectSnapshot()!;
		host.manager.undo();
		const agent = await host.manager.startEditingAgent({
			runId: "parallax-controls",
			request: "שנה את תנועת שכבת העומק ביחס למצלמה",
		});
		host.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: agent.epoch,
			steps: [
				{ title: "Set parallax direction and speed", status: "inProgress" },
			],
		});
		expect(
			JSON.stringify(
				host.manager.executeEditingAgentCommand({
					type: "discover",
					query: "parallax speed",
					limit: 20,
				}),
			),
		).toContain("timeline.classic.track.update");
		host.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: agent.epoch,
			id: "timeline.classic.track.update",
		});
		host.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: agent.epoch,
			callId: "set-depth",
			id: "timeline.classic.track.update",
			input: {
				sceneId: "main-scene",
				trackId: "depth",
				change: {
					type: "parallax",
					direction: "with-camera",
					speedPercent: 850,
				},
			},
		});
		expect(host.manager.captureProjectSnapshot()).toEqual(viaUi);
		assertCoherent({ host, runtime });
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		reopened.manager.redo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(viaUi);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"canonical removal shares UI state, rolls back bad targets and restores selection after reopening",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const target = { trackId: "titles", elementId: "text-1" };
		host.editor.selection.applySelectionPatch({
			patch: { selectedElements: [target] },
		});
		const before = host.manager.captureProjectSnapshot()!;
		const selected = host.selection();
		expect(() =>
			timeline.deleteElements({
				elements: [target, { trackId: "video-track", elementId: "missing" }],
			}),
		).toThrow();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		timeline.deleteElements({ elements: [target] });
		const after = host.manager.captureProjectSnapshot()!;
		expect(after.scenes[0].tracks.overlay[0].elements).toEqual([]);
		expect(host.selection().selectedElements).toEqual([]);
		assertCoherent({ host, runtime });
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		expect(host.selection()).toEqual(selected);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
		const reopened = createHost({
			project: host.project(),
			media: host.media(),
		});
		await reopened.manager.loadHistory({ projectId: "classic-project" });
		await reopened.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
		});
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		expect(reopened.selection()).toEqual(selected);
		const reopenedTimeline = new TimelineManager(reopened.editor);
		expect(() =>
			reopenedTimeline.removeTrack({ trackId: "video-track" }),
		).toThrow();
		reopenedTimeline.removeTrack({ trackId: "titles" });
		expect(reopened.project().scenes[0].tracks.overlay).toEqual([]);
		expect(reopened.project().scenes[0].tracks.order).toEqual(["video-track"]);
		reopened.manager.undo();
		expect(reopened.manager.captureProjectSnapshot()).toEqual(before);
		await reopened.manager.flushHistory();
		reopened.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"redo retains current selection as its next undo target",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"nested commands form one undo step and retain preview ripple and reactor options",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"validation failure rolls back earlier changes and preserves redo",
	async () => {
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"media callbacks and handles survive live history; compact persisted history reopens",
	async () => {
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
		expect(host.media().find((media) => media.id === asset.id)?.file).toBe(
			file,
		);
		expect(host.project().metadata.name).toBe("Added media");
		assertCoherent({ host, runtime });
		host.manager.execute({
			command: new Rename({ host, name: "After media" }),
		});
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
	},
	INTEGRATION_TIMEOUT,
);

test(
	"text transition companion UI matches authored audio timing and reversible canonical history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { buildTextTransitionSfxElement } =
			await import("@/transitions/text-transition-sfx");
		const definitions = (
			await import("../../../../../../rust/crates/timeline/data/text-transition-sfx-presets.json")
		).default;
		const host = createHost();
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot()!;
		const original = before.scenes[0].tracks.overlay[0].elements[0];
		if (original.type !== "text") throw new Error("Fixture needs text");
		for (const preset of definitions) {
			if (preset.side !== "in" && preset.side !== "out")
				throw new Error("Invalid shared SFX side");
			const application: import("@/core/canonical-classic-session").ClassicTransitionApplication =
				{
					trackId: "titles",
					elementId: "text-1",
					presetId: preset.transitionId,
					side: preset.side,
					percent: 21,
				};
			const expected = buildTextTransitionSfxElement({
				textElement: original,
				transitionId: preset.transitionId,
				side: preset.side,
				percent: 21,
			});
			if (!expected) throw new Error("Shared SFX definition was not resolved");
			timeline.applyTextTransitionsWithSfx({ applications: [application] });
			const audios = host
				.project()
				.scenes[0].tracks.audio.flatMap((track) => track.elements);
			expect(audios).toHaveLength(1);
			if (audios[0].sourceType !== "library")
				throw new Error("Expected companion library audio");
			const { id: _created, ...actual } = audios[0];
			expect(actual).toEqual(expected);
			assertCoherent({ host, runtime });
			const after = host.manager.captureProjectSnapshot();
			expect(() =>
				timeline.applyTextTransitionsWithSfx({
					applications: [application, { ...application, elementId: "missing" }],
				}),
			).toThrow();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			host.manager.undo();
			expect(host.manager.captureProjectSnapshot()).toEqual(before);
			host.manager.redo();
			expect(host.manager.captureProjectSnapshot()).toEqual(after);
			host.manager.undo();
		}
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"failed edit retains history across paired reopening and a new client task never replays it",
	async () => {
		const { EditorAgentClient } = await import("@/editor-agent/client");
		const source = createHost();
		let bundle: EditorSessionBundle | null = null;
		const sourceRuntime = await createCanonicalTestRuntime();
		await source.manager.enableCanonical({
			runtime: sourceRuntime,
			persistSession: async (capture) => {
				bundle = structuredClone(capture());
			},
		});
		source.manager.applyEditingConversation({
			type: "user",
			text: "Rename and inspect the title",
		});
		const run = await source.manager.startEditingAgent({
			runId: "failed-edit",
			request: "Rename and inspect the title",
		});
		source.manager.executeEditingAgentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Rename and inspect", status: "inProgress" }],
		});
		source.manager.executeEditingAgentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "project.classic.commit",
		});
		const classic = (
			sourceRuntime.snapshot() as {
				project: { classic: CanonicalClassicSnapshot };
			}
		).project.classic;
		classic.document.metadata.name = "Retained unverified title";
		source.manager.executeEditingAgentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "retained-edit",
			id: "project.classic.commit",
			input: { classic },
		});
		const edited = source.manager.captureProjectSnapshot();
		source.manager.executeEditingAgentModelAction({
			epoch: source.manager.getEditingAgentSnapshot()!.epoch,
			callId: "honest-failure",
			action: {
				action: "fail",
				text: "Title changed, but visual inspection failed.",
			},
		});
		source.manager.applyEditingConversation({ type: "round", review: false });
		source.manager.applyEditingConversation({
			type: "text",
			text: "Title changed, but visual inspection failed.",
		});
		source.manager.applyEditingConversation({ type: "close" });
		expect(source.manager.getEditingAgentSnapshot()?.phase).toBe("failed");
		await source.manager.persistEditingSession();
		source.manager.detachCanonical();
		const target = createHost();
		await target.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle!,
			persistSession: async () => {},
		});
		expect(target.manager.getEditingAgentSnapshot()?.phase).toBe("failed");
		expect(target.manager.captureProjectSnapshot()).toEqual(edited);
		const revision = target.manager.getStateRevision();
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				__opencutAccountId: "local",
				location: { origin: "http://127.0.0.1:3100" },
			},
		});
		let calls = 0;
		const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
			mockFetch(async (url, init) => {
				if (String(url).endsWith("/knowledge"))
					return knowledgeFixtureResponse();
				calls += 1;
				const request = JSON.parse(String(init?.body));
				expect(JSON.stringify(request)).toContain(
					"Title changed, but visual inspection failed.",
				);
				expect(JSON.stringify(request)).toContain("Explain the retained edit");
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { id: "new-explanation", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The title changed; its appearance has not been verified." }] }] } })}\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			}),
		);
		const client = new EditorAgentClient({
			editor: target.editor,
			emit: () => {},
		});
		try {
			await client.run({
				text: "Explain the retained edit",
				model: "scripted-test-provider",
			});
			expect(calls).toBe(1);
			expect(target.manager.getEditingAgentSnapshot()?.scope.runId).not.toBe(
				"failed-edit",
			);
			expect(target.manager.getEditingAgentSnapshot()?.phase).toBe("completed");
			expect(target.manager.getEditingAgentSnapshot()?.receipts).toHaveLength(
				0,
			);
			expect(target.manager.getStateRevision()).toBe(revision);
			expect(target.manager.captureProjectSnapshot()).toEqual(edited);
			target.manager.undo();
			expect(target.project().metadata.name).toBe("Existing edit");
			target.manager.redo();
			expect(target.project().metadata.name).toBe("Retained unverified title");
			await target.manager.flushHistory();
		} finally {
			client.dispose();
			fetchMock.mockRestore();
			target.manager.detachCanonical();
			if (originalWindow === undefined)
				Reflect.deleteProperty(globalThis, "window");
			else
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					value: originalWindow,
				});
		}
	},
	INTEGRATION_TIMEOUT,
);

test(
	"typing reveal UI preserves authored segmentation, selection and atomic history",
	async () => {
		const { TimelineManager } =
			await import("@/core/managers/timeline-manager");
		const { buildTypingRevealSfxElements } =
			await import("@/text/typing-reveal-sfx");
		const host = createHost();
		const text = host.project().scenes[0].tracks.overlay[0].elements[0];
		if (text.type !== "text") throw new Error("Fixture needs text");
		text.duration = mediaTime({ ticks: 1872001 });
		const expected = buildTypingRevealSfxElements({ textElement: text });
		const runtime = await createCanonicalTestRuntime();
		await host.manager.enableCanonical({ runtime });
		const timeline = new TimelineManager(host.editor);
		const before = host.manager.captureProjectSnapshot();
		const selected = host.selection();
		timeline.updateTextRevealWithTypingSfx({
			updates: [
				{
					trackId: "titles",
					elementId: "text-1",
					patch: { captionRevealMode: "letter-by-letter", name: "Typing" },
				},
			],
			revealMode: "letter-by-letter",
		});
		const audio = host
			.project()
			.scenes[0].tracks.audio.flatMap((track) => track.elements)
			.sort((a, b) => a.startTime - b.startTime);
		expect(audio.map(({ id: _id, ...element }) => element)).toEqual(expected);
		expect(host.selection()).toEqual(selected);
		assertCoherent({ host, runtime });
		const after = host.manager.captureProjectSnapshot();
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(before);
		host.manager.redo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		timeline.updateTextRevealWithTypingSfx({
			updates: [
				{
					trackId: "titles",
					elementId: "text-1",
					patch: { captionRevealMode: "row" },
				},
			],
			revealMode: "row",
		});
		expect(
			host.project().scenes[0].tracks.audio.flatMap((track) => track.elements),
		).toHaveLength(0);
		host.manager.undo();
		expect(host.manager.captureProjectSnapshot()).toEqual(after);
		await host.manager.flushHistory();
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test("reopening an atomic checkpoint does not rewrite its archive before the next edit", async () => {
 const source = createHost();
 let bundle: EditorSessionBundle | null = null;
 await source.manager.enableCanonical({runtime: await createCanonicalTestRuntime(), persistSession: async (capture) => { bundle = structuredClone(capture()); }});
 await source.manager.flushHistory();
 expect(bundle).not.toBeNull();
 source.manager.detachCanonical();
 const reopened = createHost();
 let writes = 0;
 await reopened.manager.enableCanonical({runtime: await createCanonicalTestRuntime(), atomicBundle: bundle!, persistSession: async () => { writes++; }});
 await reopened.manager.flushHistory();
 expect(writes).toBe(0);
 await reopened.manager.persistEditingSession();
 expect(writes).toBe(1);
 reopened.manager.detachCanonical();
}, INTEGRATION_TIMEOUT);

test(
	"an old viewer save rejection cannot poison a reopened canonical session",
	async () => {
		const host = createHost();
		let rejectSave!: (error: Error) => void;
		let began!: () => void;
		const ready = new Promise<void>((resolve) => {
			began = resolve;
		});
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			persistInitial: false,
			persistSession: async (capture) => {
				capture();
				began();
				await new Promise<void>((_resolve, reject) => {
					rejectSave = reject;
				});
			},
		});
		const bundle = host.manager.captureEditingSession();
		const old = host.manager.persistEditingSession();
		const rejected = old.catch((error) => error);
		await ready;
		host.manager.detachCanonical();
		let writes = 0;
		await host.manager.enableCanonical({
			runtime: await createCanonicalTestRuntime(),
			atomicBundle: bundle,
			persistSession: async (capture) => {
				capture();
				writes++;
			},
		});
		await host.manager.flushHistory();
		await host.manager.persistEditingSession();
		rejectSave(new Error("The editor session changed"));
		expect((await rejected).message).toBe("The editor session changed");
		await host.manager.flushHistory();
		expect(writes).toBe(1);
		host.manager.detachCanonical();
	},
	INTEGRATION_TIMEOUT,
);

test(
	"disposing an idle agent panel never queues a save during editor handoff",
	async () => {
		const { EditorAgentClient } = await import("@/editor-agent/client");
		const originalWindow = globalThis.window;
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				__opencutAccountId: "local",
				location: { origin: "http://127.0.0.1:3100" },
			},
		});
		const host = createHost();
		let writes = 0;
		try {
			await host.manager.enableCanonical({
				runtime: await createCanonicalTestRuntime(),
				persistInitial: false,
				persistSession: async () => {
					writes++;
				},
			});
			const client = new EditorAgentClient({
				editor: host.editor,
				emit: () => {},
			});
			client.dispose();
			await host.manager.flushHistory();
			expect(writes).toBe(0);
		} finally {
			host.manager.detachCanonical();
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: originalWindow,
			});
		}
	},
	INTEGRATION_TIMEOUT,
);
