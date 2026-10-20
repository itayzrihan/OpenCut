// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

test("source export settings and plan survive the browser archive without changing the composition", async () => {
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
	original.mediaAssets[0].width = 3840;
	original.mediaAssets[0].height = 2160;
	session.attach({ classic: original });
	session.begin();
	session.updateSettings({
		settings: {
			exportPreferences: { resolution: "source", encoding: "compact" },
		},
	});
	session.commit({ label: "Source export", hostContext: {} });
	expect(session.read().document.scenes).toEqual(original.document.scenes);
	const input = {
		sceneId: "main-scene",
		preferences: { resolution: "source", encoding: "compact" },
		quality: "very_high",
		format: "mp4",
	};
	expect(
		session.invokeControl({
			capabilityId: "project.classic.export.plan",
			input,
		}),
	).toMatchObject({
		width: 3840,
		height: 2160,
		logicalWidth: 1920,
		codec: "hevc",
		videoBitrate: 32000000,
	});
	const reopened = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	reopened.restore(session.archive());
	expect(reopened.read()).toEqual(session.read());
	reopened.undo();
	expect(reopened.read()).toEqual(original);
	session.dispose();
	reopened.dispose();
});
