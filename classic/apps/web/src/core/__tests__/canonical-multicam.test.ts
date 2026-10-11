// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
import { podcastMulticamDefaults, analyzePodcastMulticam } from "opencut-wasm";

test("multicam uses shared Rust analysis and canonical scene/history in the browser", async () => {
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	const original = JSON.parse(
		readFileSync(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	) as CanonicalClassicSnapshot;
	original.document.settings.fps = { numerator: 25, denominator: 1 };
	for (const a of original.mediaAssets) a.duration = 80;
	original.mediaAssets.push({
		...original.mediaAssets[0],
		id: "second-camera",
	});
	session.attach({ classic: original });
	const settings = podcastMulticamDefaults({ quick: true });
	const cuts = analyzePodcastMulticam({
		envelopes: [Array(6000).fill(0.5), Array(6000).fill(0)],
		channelIds: ["a", "b"],
		duration: 60,
		settings,
	});
	expect(cuts.map((c) => c.channelId)).toEqual(["a", "b", "a", "b", "a"]);
	session.begin();
	session.invokeControl({
		capabilityId: "timeline.classic.multicam.create",
		input: {
			plan: {
				settings,
				duration: 60,
				cuts,
				channels: [
					{
						id: "a",
						name: "A",
						videoId: "video-asset",
						audioId: "video-asset",
						videoBindingRevision: 3,
						audioBindingRevision: 3,
						videoOffset: 0,
						audioOffset: 0,
						audioDelay: 0,
					},
					{
						id: "b",
						name: "B",
						videoId: "second-camera",
						audioId: "second-camera",
						videoBindingRevision: 3,
						audioBindingRevision: 3,
						videoOffset: 0,
						audioOffset: 0,
						audioDelay: 0,
					},
				],
			},
		},
	});
	session.commit({ label: "Create multicam", hostContext: {} });
	const after = session.read();
	expect(after.document.scenes).toHaveLength(3);
	const scene = after.document.scenes[2];
	expect(scene.tracks.audio).toHaveLength(2);
	expect(scene.tracks.overlay).toHaveLength(2);
	for (const [index, track] of scene.tracks.overlay.entries()) {
		expect(track.elements).toHaveLength(cuts.length);
		expect(track.elements.map((e) => e.enabled)).toEqual(
			cuts.map((c) => c.channelId === (index === 0 ? "a" : "b")),
		);
	}
	expect(
		scene.tracks.overlay.every((t) =>
			t.elements.every((e) => e.type !== "video" || !e.isSourceAudioEnabled),
		),
	).toBe(true);
	const restored = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	restored.restore(session.archive());
	expect(restored.read()).toEqual(after);
	restored.undo();
	expect(restored.read()).toEqual(original);
	restored.redo();
	expect(restored.read()).toEqual(after);
	session.dispose();
	restored.dispose();
});
