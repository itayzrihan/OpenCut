// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
test("real web runtime creates external-audio asset, gates insertion, saves preset/clock and reopens undoable clip", async () => {
	const original: CanonicalClassicSnapshot = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const camera = original.mediaAssets[0];
	camera.duration = 120;
	camera.hasAudio = true;
	original.mediaAssets.push(
		{ ...camera, id: "camera-2", duration: 100 },
		{ ...camera, id: "recorder", type: "audio", duration: 300 },
		{
			...camera,
			id: "angles",
			unifiedAngles: {
				version: 1,
				angleAssetIds: [camera.id, "camera-2"],
				defaultAngleAssetId: camera.id,
				audioAssetId: camera.id,
			},
		},
	);
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	session.attach({ classic: original });
	const mediaIds = ["angles", "recorder"];
	expect(() =>
		session.invokeControl({
			capabilityId: "media.classic.unified.with_audio.prepare",
			input: { mediaIds },
		}),
	).not.toThrow();
	session.begin();
	session.invokeControl({
		capabilityId: "media.classic.unified.with_audio.create",
		input: { mediaIds },
	});
	session.commit({ label: "Create compound", hostContext: {} });
	const created = session
		.read()
		.mediaAssets.find((a) => a.unifiedAngles?.audioFinishingVersion === 1);
	if (!created) throw Error("No compound asset");
	expect(created.duration).toBe(120);
	expect(created.unifiedAngles?.angleAssetIds).toHaveLength(2);
	expect(session.read().document.scenes).toEqual(original.document.scenes);
	const insert = {
		sceneId: original.document.scenes[0].id,
		clips: [
			{
				element: {
					type: "video",
					name: "Synced teleprompter",
					mediaId: created.id,
					startTime: 0,
					duration: 600000,
					params: {},
				},
				placement: { mode: "auto" },
			},
		],
	};
	expect(() =>
		session.invokeControl({
			capabilityId: "timeline.classic.elements.insert",
			input: insert,
		}),
	).toThrow("sync");
	session.begin();
	session.invokeControl({
		capabilityId: "media.classic.unified.sync",
		input: {
			mediaId: created.id,
			sources: [
				{
					id: camera.id,
					duration: 120,
					start: 0,
					bindingRevision: camera.bindingRevision ?? 0,
				},
				{
					id: "camera-2",
					duration: 100,
					start: 2,
					bindingRevision: camera.bindingRevision ?? 0,
				},
				{
					id: "recorder",
					duration: 300,
					start: -60,
					bindingRevision: camera.bindingRevision ?? 0,
				},
			],
		},
	});
	session.commit({ label: "Sync recorder", hostContext: {} });
	const before = session.read();
	session.begin();
	session.invokeControl({
		capabilityId: "timeline.classic.elements.insert",
		input: insert,
	});
	session.commit({ label: "Insert compound clip", hostContext: {} });
	const assembled = session.read();
	const tracks = assembled.document.scenes[0].tracks;
	const clip = [tracks.main, ...tracks.overlay]
		.flatMap((t) => t.elements)
		.find((e) => "mediaId" in e && e.mediaId === created.id);
	expect(clip?.params).toMatchObject({
		sourceAudioOffsetSeconds: 60,
		volume: 15,
		gainDb: -1,
		noiseReduction: 100,
		hardLimiterEnabled: true,
		hardLimiterCeilingDb: -1,
	});
	const reopened = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	reopened.restore(session.archive());
	expect(reopened.read()).toEqual(assembled);
	reopened.undo();
	expect(reopened.read()).toEqual(before);
	reopened.redo();
	expect(reopened.read()).toEqual(assembled);
	session.dispose();
	reopened.dispose();
});
