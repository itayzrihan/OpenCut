// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- canonical runtime validates the fixture and persisted document. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { podcastMulticamDefaults } from "opencut-wasm";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
test("Advanced Podcast provenance survives browser archive, reload and undo", async () => {
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
	const camera = original.mediaAssets.find((a) => a.id === "video-asset")!;
	camera.duration = 2000;
	for (const [i, time] of ["1635", "1705"].entries())
		original.mediaAssets.push({
			...camera,
			id: `mic-${i}`,
			type: "audio",
			name: `20260720_${time}_000${i + 5}_32Float_9P8HShlishya1.wav`,
			duration: i ? 100 : 1800.15,
			bindingRevision: 0,
		});
	session.attach({ classic: original });
	const grouped = session.invokeControl({
		capabilityId: "timeline.classic.multicam.recordings.group",
		input: { mediaIds: ["mic-1", "mic-0"] },
	}) as import("opencut-wasm").PodcastRecordingGroups;
	expect(grouped.issues).toEqual([]);
	expect(grouped.microphones[0]!.segments[0]!.recording.mediaId).toBe("mic-0");
	session.begin();
	session.invokeControl({
		capabilityId: "timeline.classic.multicam.create",
		input: {
			plan: {
				settings: podcastMulticamDefaults({ quick: true }),
				duration: 1900.12,
				cuts: [{ timestamp: 0, duration: 1900.12, channelId: "wide" }],
				channels: [
					{
						id: "wide",
						name: "Wide",
						videoId: camera.id,
						audioId: "mic-0",
						videoBindingRevision: camera.bindingRevision ?? 0,
						audioBindingRevision: 0,
						videoOffset: 0,
						audioOffset: 0,
						audioDelay: 0,
					},
				],
				advanced: {
					microphones: grouped.microphones,
					starts: { "20260720-9P8H": 0 },
					routing: {
						microphoneIds: ["20260720-9P8H"],
						cameras: [{ channelId: "wide", microphoneIds: ["20260720-9P8H"] }],
					},
				},
			},
		},
	});
	session.commit({ label: "Advanced Podcast", hostContext: {} });
	const after = session.read();
	const scene = after.document.scenes.at(-1)!;
	expect(scene.tracks.audio).toHaveLength(1);
	expect(scene.tracks.audio[0]!.elements).toHaveLength(2);
	const reloaded = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	reloaded.restore(session.archive());
	expect(reloaded.read()).toEqual(after);
	reloaded.undo();
	expect(reloaded.read()).toEqual(original);
	reloaded.redo();
	expect(reloaded.read()).toEqual(after);
	session.dispose();
	reloaded.dispose();
});
