// @opencut-test-wasm: real
import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import type { SceneTracks } from "@/timeline/types";
import type { ClassicRemoval } from "../canonical-classic-session";

let tracks: SceneTracks;
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			scenes: { getActiveScene: () => ({ tracks }) },
			timeline: {
				updateTracks: (value: SceneTracks) => {
					tracks = value;
				},
			},
		}),
	},
}));

test("canonical removal matches legacy caption/track behavior and preserves unrelated feature data", async () => {
	const { DeleteElementsCommand } =
		await import("@/commands/timeline/element/delete-elements");
	const { RemoveTrackCommand } = await import("./legacy-remove-track-fixture");
	const { reconcileTextLayerWordsInCaptionSource } =
		await import("@/subtitles/caption-source-sync");
	for (const mode of [
		"timed",
		"presentation",
		"content",
		"source-id",
		"manual",
		"track",
		"main",
		"duplicate",
	] as const) {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const scene = classic.document.scenes[0];
		const first = scene.tracks.overlay[0];
		first.elements[0].params.content = "שלום!";
		first.elements[0].wordRuns = [
			{ id: "word-1", text: "שלום!", startTime: 0, endTime: 120000 },
		];
		const second = structuredClone(first);
		second.id = "titles-2";
		second.elements[0].id = "text-2";
		second.elements[0].startTime = 120000;
		second.elements[0].params.content = "עולם";
		second.elements[0].wordRuns = [
			{ id: "word-2", text: "עולם", startTime: 0, endTime: 120000 },
		];
		for (const track of [first, second]) {
			track.captionSource.words = [
				{ text: "שלום!", start: 0, end: 1 },
				{ text: "עולם", start: 1, end: 2 },
			];
			if (mode === "source-id")
				track.captionSource.sourceId = "same-transcript";
		}
		const manual = structuredClone(second);
		manual.id = "manual";
		delete manual.captionSource;
		manual.elements[0].id = "manual-text";
		manual.elements[0].startTime = 240000;
		manual.elements[0].params.content = "Manual title";
		delete manual.elements[0].wordRuns;
		scene.tracks.overlay.push(second, manual);
		scene.tracks.order = ["titles", "manual", "video-track", "titles-2"];
		if (mode === "presentation")
			first.elements[0].wordRuns = [{ id: "word-1", text: "שלום!" }];
		if (mode === "content") delete first.elements[0].wordRuns;
		scene.tracks = reconcileTextLayerWordsInCaptionSource({
			tracks: scene.tracks,
		});
		const ref =
			mode === "manual"
				? { trackId: "manual", elementId: "manual-text" }
				: mode === "main"
					? { trackId: "video-track", elementId: "item-2" }
					: { trackId: "titles", elementId: "text-1" };
		const removal: ClassicRemoval =
			mode === "track"
				? { type: "track", trackId: "titles" }
				: {
						type: "elements",
						elements: mode === "duplicate" ? [ref, ref] : [ref],
					};
		tracks = structuredClone(scene.tracks);
		const legacy =
			removal.type === "track"
				? new RemoveTrackCommand(removal.trackId)
				: new DeleteElementsCommand({ elements: removal.elements });
		legacy.execute();
		const expected = structuredClone(tracks);
		legacy.undo();
		expect(tracks).toEqual(scene.tracks);
		const runtime = await createCanonicalTestRuntime();
		try {
			runtime.invokeSync(
				"project.classic.session.attach",
				{ projectId: "classic-project", expectedRevision: 0, classic },
				null,
			);
			const before = runtime.invokeSync("app.state.read", {}, null).result.data
				.value;
			const result = runtime.invokeSync(
				"timeline.classic.remove",
				{
					projectId: "classic-project",
					sceneId: "main-scene",
					expectedRevision: before.revision,
					removal,
				},
				null,
			);
			expect(result).toBeDefined();
			const after = runtime.invokeSync("app.state.read", {}, null).result.data
				.value;
			expect(after.project.classic.document.scenes[0].tracks).toEqual(expected);
			expect(after.project.classic.document.scenes[1]).toEqual(
				before.project.classic.document.scenes[1],
			);
			expect(after.project.classic.document.futureFeature).toEqual(
				before.project.classic.document.futureFeature,
			);
			expect(after.project.classic.mediaAssets).toEqual(
				before.project.classic.mediaAssets,
			);
			runtime.invokeSync("history.undo", {}, null);
			expect(
				runtime.invokeSync("app.state.read", {}, null).result.data.value.project
					.classic,
			).toEqual(before.project.classic);
			runtime.invokeSync("history.redo", {}, null);
			expect(
				runtime.invokeSync("app.state.read", {}, null).result.data.value.project
					.classic,
			).toEqual(after.project.classic);
		} finally {
			runtime.free();
		}
	}
}, 90_000);
