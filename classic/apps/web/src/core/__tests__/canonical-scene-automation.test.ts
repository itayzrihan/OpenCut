/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Actual Rust registry validates the result. */
// @opencut-test-wasm: real
import { fullAutoEditStages } from "opencut-wasm";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "../canonical-classic-session";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";
test("live WASM registry persists scene jobs and publishes independently of the viewer", async () => {
	const classic: CanonicalClassicSnapshot = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	const session = new CanonicalClassicSession({
		runtime: await createCanonicalTestRuntime(),
		projectId: "classic-project",
	});
	session.attach({ classic });
	const result = session.invokeControl({
		capabilityId: "project.classic.automation.edit",
		input: {
			change: {
				type: "enqueue",
				jobs: [
					{
						id: "job",
						sceneId: "main-scene",
						workerProjectId: "worker",
						outputSceneId: "edited",
						action: "full-auto",
						options: {
							zoom: true,
							transitions: true,
							wordAnimation: true,
							music: true,
						},
					},
				],
			},
		},
	}) as { workers: Array<{ project: CanonicalClassicSnapshot["document"] }> };
	const source = session.read();
	expect(source.document.scenes).toEqual(classic.document.scenes);
	session.openScene("other-scene");
	const worker = { ...classic, document: result.workers[0].project };
	session.invokeControl({
		capabilityId: "project.classic.automation.edit",
		input: { change: { type: "publish", jobId: "job", worker } },
	});
	expect(session.read().document.scenes).toHaveLength(3);
	expect(session.currentSceneView().sceneId).toBe("other-scene");
	expect(session.read().document.settings).toEqual(classic.document.settings);
	session.undo();
	expect(session.read().document.scenes).toEqual(classic.document.scenes);
});

test("individual scene actions use their own native recipe instead of running the full pipeline", () => {
	const base = {
		zoom: true,
		transitions: true,
		wordAnimation: true,
		music: true,
	};
	for (const action of [
		"center-subject",
		"framing",
		"zoom",
		"transitions",
		"word-animation",
		"music",
		"auto-texts",
	]) {
		expect(fullAutoEditStages({ ...base, action })).toEqual([action, "save"]);
	}
	expect(fullAutoEditStages({ ...base, action: "full-auto" })).toHaveLength(10);
});
