import { expect, test } from "bun:test";
import type { BatchRun } from "./types";
import { findSceneCheckpoint } from "./scene-checkpoint";
const run = ({ id, sceneId }: { id: string; sceneId?: string }): BatchRun => ({
	id,
	options: {
		zoom: false,
		transitions: false,
		wordAnimation: false,
		music: false,
	},
	updatedAt: 0,
	jobs: [
		{
			projectId: "project",
			sceneId,
			name: "",
			fileName: "",
			status: "failed",
			message: "",
			cancelRequested: false,
			created: true,
			completedStages: 5,
		},
	],
});
test("old unscoped failures do not become another scene's resume button", () => {
	const legacy = run({ id: "legacy" });
	expect(
		findSceneCheckpoint({ runs: [legacy], projectId: "project", sceneId: "b" }),
	).toBe(legacy);
	const b = run({ id: "b", sceneId: "b" });
	expect(
		findSceneCheckpoint({
			runs: [b, legacy],
			projectId: "project",
			sceneId: "a",
		}),
	).toBeUndefined();
	expect(
		findSceneCheckpoint({
			runs: [b, legacy],
			projectId: "project",
			sceneId: "b",
		}),
	).toBe(b);
	const a = run({ id: "a", sceneId: "a" });
	expect(
		findSceneCheckpoint({
			runs: [b, a, legacy],
			projectId: "project",
			sceneId: "a",
		}),
	).toBe(a);
});
