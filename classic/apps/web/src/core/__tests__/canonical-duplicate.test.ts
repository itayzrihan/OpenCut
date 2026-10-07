// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Compare serialized fixtures across actual Rust WASM and the frozen legacy command. */
import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import type { SceneTracks } from "@/timeline/types";
import type { EditorCore } from "@/core";

let tracks: SceneTracks;
let timeline: import("../managers/timeline-manager").TimelineManager;
const editor = {
	get timeline() {
		return timeline;
	},
	command: { discardClassicMaskPreview: () => undefined },
	scenes: {
		getActiveScene: () => ({ tracks }),
		getActiveSceneOrNull: () => ({ tracks }),
		updateSceneTracks: ({ tracks: value }: { tracks: SceneTracks }) => {
			tracks = value;
		},
	},
};
mock.module("@/core", () => ({ EditorCore: { getInstance: () => editor } }));

type Ref = { trackId: string; elementId: string };
function replaceIds({
	value,
	ids,
}: {
	value: unknown;
	ids: Map<string, string>;
}): unknown {
	if (typeof value === "string") return ids.get(value) ?? value;
	if (Array.isArray(value))
		return value.map((item) => replaceIds({ value: item, ids }));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				replaceIds({ value: item, ids }),
			]),
		);
	return value;
}
function compareIds({
	actual,
	expected,
	ids,
}: {
	actual: unknown;
	expected: unknown;
	ids: Map<string, string>;
}) {
	if (
		!actual ||
		!expected ||
		typeof actual !== "object" ||
		typeof expected !== "object"
	)
		return;
	const a = actual as Record<string, unknown>;
	const b = expected as Record<string, unknown>;
	if (typeof a.id === "string" && typeof b.id === "string") ids.set(a.id, b.id);
	for (const [key, value] of Object.entries(a))
		compareIds({ actual: value, expected: b[key], ids });
}
function all(value: SceneTracks) {
	return [...value.overlay, value.main, ...value.audio];
}

test("canonical duplication matches legacy placement, animation, caption ownership and feature preservation", async () => {
	const { DuplicateElementsCommand } =
		await import("./legacy-duplicate-elements-fixture");
	const { TimelineManager } = await import("../managers/timeline-manager");
	timeline = new TimelineManager(editor as unknown as EditorCore);
	for (const mode of [
		"video",
		"captions",
		"manual-text",
		"audio",
		"mixed",
		"duplicate-ref",
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
		const caption = scene.tracks.overlay[0].elements[0];
		caption.params.content = "שלום";
		caption.wordRuns = [
			{
				id: "word-1",
				text: "שלום",
				lineIndex: 0,
				startTime: 0,
				endTime: 120000,
			},
		];
		const scalar = ({ id, value }: { id: string; value: number }) => ({
			keys: [
				{ id, time: 0, value, segmentToNext: "linear", tangentMode: "flat" },
			],
			extrapolation: { before: "hold", after: "hold" },
		});
		scene.tracks.main.elements[0].animations = {
			opacity: scalar({ id: "opacity-key", value: 0.7 }),
			color: {
				r: scalar({ id: "color-key", value: 255 }),
				g: scalar({ id: "color-key", value: 0 }),
				b: scalar({ id: "color-key", value: 20 }),
				a: scalar({ id: "color-key", value: 1 }),
			},
			"future.flag": { keys: [{ id: "flag-key", time: 0, value: true }] },
		};
		const manual = {
			id: "manual",
			name: "Manual",
			type: "text",
			hidden: false,
			elements: [
				{
					...structuredClone(caption),
					id: "manual-text",
					name: "Manual text",
					params: { ...caption.params, content: "עולם" },
					wordRuns: [
						{
							id: "manual-word",
							text: "עולם",
							lineIndex: 0,
							startTime: 0,
							endTime: 120000,
						},
					],
				},
			],
		};
		scene.tracks.overlay.push(manual);
		scene.tracks.audio = [
			{
				id: "music",
				name: "Music",
				type: "audio",
				muted: true,
				elements: [
					{
						id: "sound",
						name: "Sound",
						type: "audio",
						sourceType: "library",
						libraryAssetId: "library-sound",
						sourceUrl: "https://example.invalid/sound",
						startTime: 240000,
						duration: 120000,
						trimStart: 0,
						trimEnd: 0,
						params: { volume: 0.7 },
					},
				],
			},
		];
		scene.tracks.order = ["music", "titles", "video-track", "manual"];
		tracks = structuredClone(scene.tracks);
		timeline.updateTracks(tracks);
		scene.tracks = structuredClone(tracks);
		const video = { trackId: "video-track", elementId: "item-2" };
		const text = { trackId: "titles", elementId: "text-1" };
		const sound = { trackId: "music", elementId: "sound" };
		const elements =
			mode === "mixed"
				? [sound, video, text]
				: mode === "captions"
					? [text]
					: mode === "manual-text"
						? [{ trackId: "manual", elementId: "manual-text" }]
						: mode === "audio"
							? [sound]
							: mode === "duplicate-ref"
								? [video, video]
								: [video];
		const legacy = new DuplicateElementsCommand({ elements });
		legacy.execute();
		const expected = structuredClone(tracks);
		const legacyRefs = legacy.getDuplicatedElements();
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
			const receipt = runtime.invokeSync(
				"timeline.classic.elements.duplicate",
				{
					projectId: "classic-project",
					sceneId: "main-scene",
					expectedRevision: before.revision,
					elements,
				},
				null,
			);
			const refs = receipt.result.data.elements as Ref[];
			const after = runtime.invokeSync("app.state.read", {}, null).result.data
				.value;
			const actual = after.project.classic.document.scenes[0]
				.tracks as SceneTracks;
			expect(refs.length).toBe(legacyRefs.length);
			const ids = new Map<string, string>();
			for (const [index, ref] of refs.entries()) {
				const legacyRef = legacyRefs[index];
				ids.set(ref.trackId, legacyRef.trackId);
				ids.set(ref.elementId, legacyRef.elementId);
				const a = all(actual)
					.find((t) => t.id === ref.trackId)
					?.elements.find((e) => e.id === ref.elementId);
				const b = all(expected)
					.find((t) => t.id === legacyRef.trackId)
					?.elements.find((e) => e.id === legacyRef.elementId);
				compareIds({ actual: a, expected: b, ids });
			}
			expect(replaceIds({ value: actual, ids })).toEqual(expected);
			expect(after.project.classic.mediaAssets).toEqual(
				before.project.classic.mediaAssets,
			);
			expect(after.project.classic.document.scenes[1]).toEqual(
				before.project.classic.document.scenes[1],
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
