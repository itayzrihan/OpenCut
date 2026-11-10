/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The fixture intentionally implements only the EditorCore boundary read by these guards. */
import { afterEach, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { DirectorBatch, DirectorJob } from "./types";
import { matchBatchJobs, validateChapterBatch } from "./batch-validation";
const original = globalThis.window;
afterEach(() =>
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: original,
	}),
);
const job: DirectorJob = {
	id: "a".repeat(32),
	projectId: "project",
	kind: "video",
	status: "review",
	digest: "b".repeat(64),
	prompt: "Frozen prompt",
	model: "model",
	references: [],
	createdAt: 1,
	message: "Review",
};
const batch: DirectorBatch = {
	id: "c".repeat(32),
	projectId: "project",
	kind: "chapters",
	digest: "d".repeat(64),
	jobs: [{ id: job.id, digest: job.digest }],
	createdAt: 1,
	status: "review",
	message: "Review",
};
test("batch approval requires exact complete ID, digest and project coverage", () => {
	expect(
		matchBatchJobs({ batch, jobs: [], projectId: "project" }).complete,
	).toBe(false);
	expect(
		matchBatchJobs({
			batch,
			jobs: [{ ...job, digest: "e".repeat(64) }],
			projectId: "project",
		}).complete,
	).toBe(false);
	expect(
		matchBatchJobs({
			batch,
			jobs: [{ ...job, projectId: "other" }],
			projectId: "project",
		}).complete,
	).toBe(false);
	expect(matchBatchJobs({ batch, jobs: [job], projectId: "project" })).toEqual({
		jobs: [job],
		complete: true,
	});
});
test("source guard checks exact canonical chapter and seam anchors without forwarding receipt fields", () => {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { __opencutAccountId: "account" },
	});
	const calls: { capabilityId: string; input: Record<string, unknown> }[] = [];
	let current = "anchor";
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project" } }) },
		scenes: { getActiveSceneOrNull: () => ({ id: "scene" }) },
		command: {
			invokeCanonicalControl: (call: {
				capabilityId: string;
				input: Record<string, unknown>;
			}) => {
				calls.push(call);
				if (call.capabilityId === "timeline.classic.bridge.plan") {
					expect(call.input).not.toHaveProperty("anchor");
					return { anchor: current, cutTime: 1, rightStart: 1 };
				}
				return {
					plan: { version: 1, chapters: [{ id: "one", prompt: job.prompt }] },
				};
			},
		},
	} as unknown as EditorCore;
	const seam = {
		...job,
		seamless: {
			sceneId: "scene",
			trackId: "track",
			leftId: "left",
			rightId: "right",
			anchor: "anchor",
		},
	};
	const chapter = {
		...job,
		chapter: {
			planId: "plan",
			planVersion: 1,
			chapterId: "one",
			index: 0,
			total: 1,
			title: "One",
		},
	};
	validateChapterBatch({ editor, jobs: [seam, chapter] });
	expect(calls.map((c) => c.capabilityId)).toEqual([
		"timeline.classic.bridge.plan",
		"project.generative.chapters.validate",
	]);
	current = "changed";
	expect(() => validateChapterBatch({ editor, jobs: [seam] })).toThrow(
		"source clips changed",
	);
	expect(() =>
		validateChapterBatch({ editor, jobs: [{ ...job, projectId: "other" }] }),
	).toThrow("project changed");
});
