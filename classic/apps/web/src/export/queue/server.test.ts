// @opencut-test-wasm: real
import { test, expect, mock, afterAll } from "bun:test";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { ExportOptions } from "@/export";
const initial = await createCanonicalTestRuntime();
const Runtime = initial.constructor;
initial.free();
mock.module("opencut-editor-runtime-wasm", () => ({
	CanonicalEditorRuntime: Runtime,
}));
const root = await mkdtemp(join(tmpdir(), "opencut-render-queue-"));
const source = join(root, "original.mp4");
await writeFile(source, "frozen media fixture");
mock.module("@/accounts/server", () => ({ accountDataRoot: () => root }));
let currentSource = source;
mock.module("@/services/local-drive/server", () => ({
	getProject: async () => ({ metadata: { id: "classic-project" } }),
	getMediaFile: async (_project: string, id: string) => ({
		path: currentSource,
		stat: await stat(currentSource),
		record: {
			id,
			storageKind: "linked",
			sourcePath: currentSource,
			mimeType: "video/mp4",
		},
	}),
	getFontFile: async () => null,
	getSharedFile: async () => null,
}));
const {
	enqueueRender,
	readRenderQueue,
	claimRender,
	reportRender,
	changeRender,
	readRenderJob,
	renderSource,
} = await import("./server");
const fixture = JSON.parse(
	await readFile(
		new URL(
			"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
			import.meta.url,
		),
		"utf8",
	),
) as CanonicalClassicSnapshot;
for (const asset of fixture.mediaAssets) asset.sourcePath = source;
const options: ExportOptions = {
	format: "mp4",
	quality: "high",
	preferences: { resolution: "project", encoding: "compatible" },
	fps: { numerator: 25, denominator: 1 },
	includeAudio: true,
};
const submit = (id: string) =>
	enqueueRender({
		id,
		projectId: "classic-project",
		sceneId: "main-scene",
		sourceRevision: 5,
		snapshot: structuredClone(fixture),
		options,
	});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	mock.restore();
});
test("durable canonical host queue deduplicates concurrent submissions and isolates source relinks", async () => {
	await Promise.all([
		submit("job-first"),
		submit("job-first"),
		submit("job-second"),
	]);
	let state = await readRenderQueue();
	expect(state.jobs).toHaveLength(2);
	expect(state.jobs.map((j) => j.status)).toEqual(["queued", "queued"]);
	const [a, b] = await Promise.all([
		claimRender("attempt-a"),
		claimRender("attempt-b"),
	]);
	const job = a ?? b;
	expect(job).not.toBeNull();
	expect([a, b].filter(Boolean)).toHaveLength(1);
	if (!job?.attempt) throw Error("Missing claimed worker");
	const originalHash = job.snapshotHash;
	const changed = join(root, "relinked.mp4");
	await writeFile(changed, "different source");
	currentSource = changed;
	const frozen = await renderSource(job.id, fixture.mediaAssets[0].id, "media");
	expect(frozen.path).toBe(source);
	const before = await readRenderJob(job.id);
	expect(before.snapshotHash).toBe(originalHash);
	state = await readRenderQueue();
	await changeRender({
		id: job.id,
		projectId: job.projectId,
		type: "cancel",
		expectedRevision: state.revision,
	});
	const receipt = await reportRender({
		id: job.id,
		projectId: job.projectId,
		attempt: job.attempt,
		status: "completed",
		progress: 1,
		message: "Done",
	});
	expect(receipt.status).toBe("cancelled");
	state = await readRenderQueue();
	await changeRender({
		id: job.id,
		projectId: job.projectId,
		type: "retry",
		expectedRevision: state.revision,
	});
	expect((await readRenderJob(job.id)).snapshotHash).toBe(originalHash);
	await expect(
		reportRender({
			id: job.id,
			projectId: job.projectId,
			attempt: job.attempt,
			status: "completed",
			progress: 1,
			message: "Late",
		}),
	).rejects.toThrow();
	const stored = JSON.parse(
		await readFile(join(root, "render-queue", "runtime.json"), "utf8"),
	);
	expect(JSON.stringify(stored)).toContain(originalHash);
	await writeFile(source, "source mutated after enqueue");
	await expect(
		renderSource(job.id, fixture.mediaAssets[0].id, "media"),
	).rejects.toThrow("changed");
});
test("per-job settings update only while queued and stale revisions cannot cancel jobs", async () => {
	const state = await readRenderQueue();
	const second = state.jobs.find((j) => j.id === "job-second")!;
	await changeRender({
		id: second.id,
		projectId: second.projectId,
		type: "configure",
		options: { ...options, quality: "low" },
		expectedRevision: state.revision,
	});
	expect((await readRenderJob(second.id)).options.quality).toBe("low");
	await expect(
		changeRender({
			id: second.id,
			projectId: second.projectId,
			type: "cancel",
			expectedRevision: state.revision,
		}),
	).rejects.toThrow("changed");
});
