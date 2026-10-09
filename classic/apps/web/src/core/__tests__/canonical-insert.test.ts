// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Serialized migration fixtures cross the actual WASM and legacy command boundaries. */
import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { EditorCore } from "@/core";
import type { SceneTracks, CreateTimelineElement } from "@/timeline/types";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import { bindProductAnimationCatalog } from "@/animation/product-catalog";
import { graphicsRegistry } from "@/graphics/registry";
import { mediaTime } from "@/wasm";

let classic: import("../canonical-classic-session").CanonicalClassicSnapshot;
let timeline: import("../managers/timeline-manager").TimelineManager;
const editor = {
	get timeline() {
		return timeline;
	},
	command: { discardClassicMaskPreview: () => undefined },
	project: {
		getActive: () => classic.document,
		updateSettings: ({ settings }: { settings: Record<string, unknown> }) =>
			Object.assign(classic.document.settings, settings),
	},
	media: { getAssets: () => classic.mediaAssets },
	scenes: {
		getActiveScene: () => classic.document.scenes[0],
		getActiveSceneOrNull: () => classic.document.scenes[0],
		updateSceneTracks: ({ tracks }: { tracks: SceneTracks }) => {
			classic.document.scenes[0].tracks = tracks;
		},
	},
};
mock.module("@/core", () => ({ EditorCore: { getInstance: () => editor } }));
function rewrite({
	value,
	ids,
}: {
	value: unknown;
	ids: Map<string, string>;
}): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value))
		return value.map((item) => rewrite({ value: item, ids }));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				key === "updatedAt" ? "timestamp" : rewrite({ value: item, ids }),
			]),
		);
	return value;
}
test("canonical creation matches legacy placement, type data, catalog and first-media settings", async () => {
	const { InsertElementCommand } =
		await import("@/commands/timeline/element/insert-element");
	const { TimelineManager } = await import("../managers/timeline-manager");
	timeline = new TimelineManager(editor as unknown as EditorCore);
	for (const mode of [
		"video-auto",
		"video-explicit",
		"main-anchor",
		"text",
		"audio",
		"sticker",
		"graphic",
		"effect",
		"first-video",
		"first-image",
		"new-index",
		"bad-order",
	] as const) {
		classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		Object.assign(classic.mediaAssets[0], {
			width: 1280,
			height: 720,
			fps: 29.97,
		});
		classic.mediaAssets.push({
			...classic.mediaAssets[0],
			id: "image",
			type: "image",
			width: 800,
			height: 600,
		});
		for (const track of classic.document.scenes[0].tracks.overlay)
			for (const element of track.elements)
				if (element.type === "text") {
					element.params.content = "שלום";
					element.wordRuns = [{ id: "word-1", text: "שלום", lineIndex: 0 }];
				}
		if (mode.startsWith("first")) {
			classic.document.scenes[0].tracks.main.elements = [];
			classic.document.scenes[0].tracks.overlay[0].elements = [];
		}
		if (mode === "main-anchor")
			classic.document.scenes[0].tracks.main.elements[0].startTime = mediaTime({ ticks: 240000 });
		if (mode === "bad-order")
			classic.document.scenes[0].tracks.order = [
				"missing",
				"titles",
				"titles",
				"video-track",
			];
		const runtime = await createCanonicalTestRuntime();
		const dispose = bindProductAnimationCatalog((groups) =>
			runtime.setAnimationCatalog(groups),
		);
		try {
			const graphicId = graphicsRegistry
				.entries()
				.find(([id]) => id !== "hyperframes")![0];
			const kind = ["text", "audio", "sticker", "graphic", "effect"].includes(
				mode,
			)
				? mode
				: mode === "first-image"
					? "image"
					: "video";
			const draft = {
				type: kind,
				name: "New clip",
				startTime: mode === "main-anchor" ? 120000 : 240000,
				params: kind === "text" ? { content: "שלום חדש" } : {},
				...(kind === "video"
					? { mediaId: "video-asset" }
					: kind === "image"
						? { mediaId: "image" }
						: kind === "audio"
							? { sourceType: "library", libraryAssetId: "sound" }
							: kind === "sticker"
								? { stickerId: "icon:test" }
								: kind === "graphic"
									? { definitionId: graphicId }
									: kind === "effect"
										? { effectType: "custom-ai" }
										: {}),
				future: { retained: true },
			} as unknown as CreateTimelineElement;
			const placement = ["video-explicit", "main-anchor", "bad-order"].includes(
				mode,
			)
				? { mode: "explicit" as const, trackId: "video-track" }
				: {
						mode: "auto" as const,
						...(mode === "new-index" ? { insertIndex: 999 } : {}),
					};
			const before = structuredClone(classic);
			const legacy = new InsertElementCommand({ element: draft, placement });
			legacy.execute();
			const expected = structuredClone(classic);
			const legacyRef = {
				trackId: legacy.getTrackId()!,
				elementId: legacy.getElementId(),
			};
			runtime.invokeSync(
				"project.classic.session.attach",
				{ projectId: "classic-project", expectedRevision: 0, classic: before },
				null,
			);
			const state = runtime.invokeSync("app.state.read", {}, null).result.data
				.value;
			const catalog = runtime.invokeSync(
				"timeline.classic.elements.catalog",
				{ projectId: "classic-project", expectedRevision: state.revision },
				null,
			).result.data;
			const result = runtime.invokeSync(
				"timeline.classic.elements.insert",
				{
					projectId: "classic-project",
					sceneId: "main-scene",
					expectedRevision: state.revision,
					catalogRevision: catalog.catalogRevision,
					clips: [{ element: draft, placement }],
				},
				null,
			).result.data;
			const ref = result.elements[0];
			const after = runtime.invokeSync("app.state.read", {}, null).result.data
				.value.project.classic;
			const ids = new Map([
				[ref.trackId, legacyRef.trackId],
				[ref.elementId, legacyRef.elementId],
			]);
			// Duration is a derived cache; creation updates it in the canonical model.
			const tracks = expected.document.scenes[0].tracks;
			expected.document.metadata.duration = Math.max(
				0,
				...[...tracks.overlay, tracks.main, ...tracks.audio].flatMap((t) =>
					t.elements.map((e) => e.startTime + e.duration),
				),
			) as typeof expected.document.metadata.duration;
			expect(rewrite({ value: after, ids })).toEqual(
				rewrite({ value: expected, ids: new Map() }),
			);
			runtime.invokeSync("history.undo", {}, null);
			expect(
				runtime.invokeSync("app.state.read", {}, null).result.data.value.project
					.classic,
			).toEqual(before);
			runtime.invokeSync("history.redo", {}, null);
			expect(
				runtime.invokeSync("app.state.read", {}, null).result.data.value.project
					.classic,
			).toEqual(after);
		} finally {
			dispose();
			runtime.free();
		}
	}
}, 90_000);
