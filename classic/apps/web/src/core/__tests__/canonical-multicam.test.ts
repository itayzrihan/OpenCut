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
			allowCameraAudio: true,
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

test("Unified sound synchronization survives the browser canonical archive and undo", async () => {
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
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
	original.mediaAssets[0].duration = 3600;
	original.mediaAssets.push({
		...original.mediaAssets[0],
		id: "short",
		duration: 1800,
	});
	original.mediaAssets.push({
		id: "unified",
		name: "Speaker",
		type: "video",
		duration: 1800,
		unifiedAngles: {
			version: 1,
			angleAssetIds: ["short", "video-asset"],
			defaultAngleAssetId: "short",
			audioAssetId: "short",
		},
	});
	session.attach({ classic: original });
	session.begin();
	session.invokeControl({
		capabilityId: "media.classic.unified.sync",
		input: {
			mediaId: "unified",
			sources: [
				{ id: "short", duration: 1800, start: 50, bindingRevision: 3 },
				{ id: "video-asset", duration: 3600, start: 20, bindingRevision: 3 },
			],
		},
	});
	session.commit({ label: "Synchronize Unified Angles", hostContext: {} });
	const synced = session.read();
	expect(synced.mediaAssets.at(-1)?.duration).toBe(3600);
	expect(synced.mediaAssets.at(-1)?.unifiedAngles?.sync?.sources[0].start).toBe(
		30,
	);
	const restored = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	restored.restore(session.archive());
	expect(restored.read()).toEqual(synced);
	restored.undo();
	expect(restored.read()).toEqual(original);
	restored.redo();
	expect(restored.read()).toEqual(synced);
	restored.dispose();
	session.dispose();
});

test("browser suggestions and finishing preserve WAV source identities", async () => {
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
	original.mediaAssets[0].name = "C7453lior.MP4";
	original.mediaAssets[0].duration = 80;
	original.mediaAssets.push({
		id: "lior-mic",
		name: "240427_0144_1lior.wav",
		type: "audio",
		duration: 80,
	});
	session.attach({ classic: original });
	const before = session.read();
	const proposal = session.invokeControl({
		capabilityId: "timeline.classic.multicam.sources.suggest",
		input: { videoIds: ["video-asset"] },
	}) as { suggestions: Array<{ audioId: string }> };
	expect(proposal.suggestions[0].audioId).toBe("lior-mic");
	expect(session.read()).toEqual(before);
	const plan = {
		settings: podcastMulticamDefaults({ quick: true }),
		duration: 60,
		cuts: [{ timestamp: 0, duration: 60, channelId: "a" }],
		channels: [
			{
				id: "a",
				name: "Lior",
				videoId: "video-asset",
				audioId: proposal.suggestions[0].audioId,
				videoBindingRevision: 3,
				audioBindingRevision: 0,
				videoOffset: 0,
				audioOffset: 2,
				audioDelay: 0,
			},
		],
	};
	session.begin();
	session.invokeControl({
		capabilityId: "timeline.classic.multicam.create",
		input: { plan, finishPodcast: true },
	});
	session.commit({ label: "Podcast WAV", hostContext: {} });
	const scene = session.read().document.scenes.at(-1)!;
	const microphone = scene.tracks.audio[0].elements[0];
	expect(microphone).toMatchObject({
		mediaId: "lior-mic",
		trimStart: 240000,
		params: {
			noiseReduction: 100,
			volume: 15,
			gainDb: -1,
			hardLimiterEnabled: true,
		},
	});
	expect(
		scene.tracks.overlay
			.filter((t) => t.type === "video")
			.every((t) => t.muted),
	).toBe(true);
	session.undo();
	expect(session.read()).toEqual(before);
	session.redo();
	expect(
		session.read().document.scenes.at(-1)?.tracks.audio[0].elements[0],
	).toEqual(microphone);
	session.dispose();
});
