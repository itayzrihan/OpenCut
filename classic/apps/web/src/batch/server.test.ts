import { newBrandKit, type BrandKit } from "@/brand-kits/types";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
let brandLibrary: BrandKit[] = [];
mock.module("@/brand-kits/server", () => ({
	brandKitTransaction: async () => ({
		accountId: "alice",
		revision: 1,
		kits: structuredClone(brandLibrary),
	}),
}));
const projects = new Map<
	string,
	{
		metadata: { name: string; updatedAt: string };
		currentSceneId?: string;
		automationEdits?: import("./scene-jobs").SceneJob[];
		automationCheckpoint?: number;
		automationSource?: { projectId: string; jobId: string; sceneId: string };
		scenes?: Array<{ id: string; name: string }>;
	}
>();
const root = await mkdtemp(join(tmpdir(), "opencut-batch-test-"));
mock.module("@/services/local-drive/server", () => ({
	getLocalDriveStatus: async () => ({ rootPath: root }),
	getProject: async (id: string) => projects.get(id) ?? null,
}));
// Native lifecycle transitions are covered by the Rust tests. Here test the host lease and durable queue.
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => [
		"preflight",
		"framing",
		"silence",
		"auto-texts",
		"finish",
		"save",
	],
	batchEditIsLocked: ({ status }: { status: string }) =>
		["queued", "importing", "ready", "running"].includes(status),
	batchEditTransition: ({
		status,
		event,
	}: {
		status: string;
		event: string;
	}) => {
		if (
			event === "recover" &&
			["ready", "running", "interrupted"].includes(status)
		)
			return "ready";
		if (event === "retry" && ["failed", "interrupted"].includes(status))
			return "ready";
		if (!["queued", "importing", "ready", "running"].includes(status))
			return "";
		return (
			(
				{
					"queued:import": "importing",
					"importing:ready": "ready",
					"ready:run": "running",
					"running:complete": "completed",
				} as Record<string, string>
			)[`${status}:${event}`] ??
			(
				{
					cancel: "cancelled",
					fail: "failed",
					interrupt: "interrupted",
				} as Record<string, string>
			)[event] ??
			""
		);
	},
}));
const {
	createBatch,
	createProjectEdit,
	withBatchProjectWrite,
	getBatchState,
	updateBatch,
	cancelBatch,
	assertBatchProjectWrite,
	createSceneEdits,
	recoverSceneWorker,
	retrySceneEdit,
} = await import("./server");
const options = {
	zoom: true,
	transitions: false,
	wordAnimation: true,
	music: true,
};
afterAll(async () => {
	if (!resolve(root).startsWith(resolve(tmpdir())))
		throw new Error("Unsafe test cleanup");
	await rm(root, { recursive: true, force: true });
});
describe("batch host isolation", () => {
	test("serializes concurrent starts, excludes tokens from reads and locks only owned projects", async () => {
		const attempts = await Promise.allSettled(
			["a", "b"].map((id) =>
				createBatch({
					id,
					files: [{ projectId: id, fileName: `${id}.mp4` }],
					options,
				}),
			),
		);
		expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(2);
		const success = attempts.find((r) => r.status === "fulfilled");
		if (success?.status !== "fulfilled") throw new Error("No batch");
		const { run, token } = success.value;
		expect(JSON.stringify(await getBatchState())).not.toContain(token);
		expect(run.options).toEqual(options);
		await expect(
			assertBatchProjectWrite({
				projectId: run.jobs[0].projectId,
				token: null,
			}),
		).rejects.toThrow("locked");
		await assertBatchProjectWrite({ projectId: "unrelated", token: null });
		await assertBatchProjectWrite({ projectId: run.jobs[0].projectId, token });
		await cancelBatch({ id: run.id });
		expect(
			(await getBatchState()).runs.find((r) => r.id === run.id)!.jobs[0]
				.cancelRequested,
		).toBe(true);
		expect((await getBatchState()).executionRunId).toBe(run.id);
		// Cancellation stays locked until the worker has stopped and flushed its completed stages.
		await expect(
			assertBatchProjectWrite({
				projectId: run.jobs[0].projectId,
				token: null,
			}),
		).rejects.toThrow("locked");
		await updateBatch({
			id: run.id,
			token,
			projectId: run.jobs[0].projectId,
			event: "cancel",
		});
		await assertBatchProjectWrite({
			projectId: run.jobs[0].projectId,
			token: null,
		});
		await expect(
			assertBatchProjectWrite({ projectId: run.jobs[0].projectId, token }),
		).rejects.toThrow("Expired");
		const second = attempts.find(
			(r) => r.status === "fulfilled" && r.value.run.id !== run.id,
		);
		if (second?.status !== "fulfilled") throw new Error("No second batch");
		expect((await getBatchState()).executionRunId).toBe(second.value.run.id);
		await updateBatch({
			id: second.value.run.id,
			token: second.value.token,
			projectId: second.value.run.jobs[0].projectId,
			event: "cancel",
		});
	});
	test("one failed job does not unlock or finish its sibling", async () => {
		const { run, token } = await createBatch({
			id: "two",
			files: [
				{ projectId: "p1", fileName: "one.mp4" },
				{ projectId: "p2", fileName: "two.mp4" },
			],
			options,
		});
		await updateBatch({
			id: run.id,
			token,
			projectId: "p1",
			event: "fail",
			message: "Bad codec",
		});
		await expect(
			assertBatchProjectWrite({ projectId: "p2", token: null }),
		).rejects.toThrow("locked");
		for (const event of ["import", "ready", "run", "complete"])
			await updateBatch({ id: run.id, token, projectId: "p2", event });
		expect((await getBatchState()).runs[0].jobs.map((j) => j.status)).toEqual([
			"failed",
			"completed",
		]);
	});
	test("expired worker loses write permission and is interrupted rather than silently resumed", async () => {
		const { run, token } = await createBatch({
			id: "expired",
			files: [{ projectId: "p3", fileName: "three.mp4" }],
			options,
		});
		const path = join(root, "batch", "queue.json");
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.runs[0].heartbeat = 0;
		await writeFile(path, JSON.stringify(stored));
		expect((await getBatchState()).runs[0].jobs[0].status).toBe("interrupted");
		await expect(updateBatch({ id: run.id, token })).rejects.toThrow("expired");
		await expect(
			assertBatchProjectWrite({ projectId: "p3", token }),
		).rejects.toThrow("Expired");
	});
});

test("existing-project handoff checks revision, rejects duplicate ownership and allows unrelated editing", async () => {
	projects.set("existing", {
		metadata: { name: "Original", updatedAt: "2026-09-22T00:00:00.000Z" },
	});
	const args = {
		id: "single",
		projectId: "existing",
		expectedUpdatedAt: "2026-09-22T00:00:00.000Z",
		options,
	};
	await expect(
		createProjectEdit({ ...args, expectedUpdatedAt: "stale" }),
	).rejects.toThrow("changed");
	const result = await createProjectEdit(args);
	expect(result.run.jobs[0].source).toBe("existing");
	expect(result.run.jobs[0].status).toBe("ready");
	await expect(createProjectEdit({ ...args, id: "duplicate" })).rejects.toThrow(
		"active",
	);
	await expect(
		assertBatchProjectWrite({ projectId: "existing", token: null }),
	).rejects.toThrow("locked");
	await assertBatchProjectWrite({ projectId: "unrelated", token: null });
	await updateBatch({
		id: args.id,
		token: result.token,
		projectId: "existing",
		event: "run",
		completedStages: 2,
	});
	await expect(
		updateBatch({
			id: args.id,
			token: result.token,
			projectId: "existing",
			completedStages: 1,
		}),
	).rejects.toThrow("progress");
	await expect(
		updateBatch({
			id: args.id,
			token: result.token,
			projectId: "existing",
			completedStages: 99,
		}),
	).rejects.toThrow("progress");
	await updateBatch({
		id: args.id,
		token: result.token,
		projectId: "existing",
		event: "complete",
	});
	const rerun = await createProjectEdit({ ...args, id: "single-again" });
	await expect(
		assertBatchProjectWrite({ projectId: "existing", token: result.token }),
	).rejects.toThrow("Expired");
	await updateBatch({
		id: rerun.run.id,
		token: rerun.token,
		projectId: "existing",
		event: "cancel",
	});
});
test("handoff cannot overtake an in-flight document write", async () => {
	projects.set("race", { metadata: { name: "Race", updatedAt: "old" } });
	let release!: () => void;
	let entered!: () => void;
	const enteredPromise = new Promise<void>((r) => (entered = r));
	const pending = withBatchProjectWrite({
		projectId: "race",
		token: null,
		write: async () => {
			entered();
			await new Promise<void>((r) => (release = r));
			projects.get("race")!.metadata.updatedAt = "new";
		},
	});
	await enteredPromise;
	const enqueue = createProjectEdit({
		id: "race-job",
		projectId: "race",
		expectedUpdatedAt: "old",
		options,
	});
	release();
	await pending;
	await expect(enqueue).rejects.toThrow("changed");
});

test("queued imports reserve their project ids before project creation", async () => {
	const first = await createBatch({
		id: "reserve-first",
		files: [{ projectId: "reserved", fileName: "a.mp4" }],
		options,
	});
	await expect(
		createBatch({
			id: "reserve-second",
			files: [{ projectId: "reserved", fileName: "b.mp4" }],
			options,
		}),
	).rejects.toThrow("new project ids");
	await expect(
		createBatch({
			id: "duplicate-files",
			files: [
				{ projectId: "duplicate", fileName: "a.mp4" },
				{ projectId: "duplicate", fileName: "b.mp4" },
			],
			options,
		}),
	).rejects.toThrow("new project ids");
	await updateBatch({
		id: first.run.id,
		token: first.token,
		projectId: "reserved",
		event: "cancel",
	});
});

test("resume preserves a failed finishing checkpoint and rejects stale or changed recipes", async () => {
	const projectId = "resume-project",
		stamp = "2026-09-29T10:00:00.000Z";
	projects.set(projectId, { metadata: { name: "Resume", updatedAt: stamp } });
	const original = await createProjectEdit({
		id: "resume-original",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "run",
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "fail",
		completedStages: 5,
	});
	const input = {
		id: "resume-next",
		projectId,
		expectedUpdatedAt: stamp,
		options,
		resumeRunId: original.run.id,
	};
	await expect(
		createProjectEdit({ ...input, expectedUpdatedAt: "stale" }),
	).rejects.toThrow("Project changed");
	await expect(
		createProjectEdit({ ...input, options: { ...options, zoom: false } }),
	).rejects.toThrow("original recipe");
	const resumed = await createProjectEdit(input);
	expect(resumed.run.jobs[0]).toMatchObject({
		source: "existing",
		status: "ready",
		completedStages: 5,
		resumeFromStage: 5,
	});
	await expect(
		createProjectEdit({ ...input, id: "duplicate-resume" }),
	).rejects.toThrow("active automatic edit");
	await updateBatch({
		id: resumed.run.id,
		token: resumed.token,
		projectId,
		event: "run",
	});
	await updateBatch({
		id: resumed.run.id,
		token: resumed.token,
		projectId,
		event: "complete",
	});
	await expect(
		createProjectEdit({ ...input, id: "old-checkpoint" }),
	).rejects.toThrow("latest failed");
});

test("resume preserves a failed caption checkpoint and rejects stale or changed recipes", async () => {
	const projectId = "resume-caption-project",
		stamp = "2026-09-29T10:00:00.000Z";
	projects.set(projectId, { metadata: { name: "Resume", updatedAt: stamp } });
	const original = await createProjectEdit({
		id: "resume-caption-original",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "run",
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "fail",
		completedStages: 3,
	});
	const input = {
		id: "resume-caption-next",
		projectId,
		expectedUpdatedAt: stamp,
		options,
		resumeRunId: original.run.id,
	};
	await expect(
		createProjectEdit({ ...input, expectedUpdatedAt: "stale" }),
	).rejects.toThrow("Project changed");
	await expect(
		createProjectEdit({ ...input, options: { ...options, zoom: false } }),
	).rejects.toThrow("original recipe");
	const resumed = await createProjectEdit(input);
	expect(resumed.run.jobs[0]).toMatchObject({
		source: "existing",
		status: "ready",
		completedStages: 3,
		resumeFromStage: 3,
	});
	await expect(
		createProjectEdit({ ...input, id: "duplicate-resume" }),
	).rejects.toThrow("active automatic edit");
	await updateBatch({
		id: resumed.run.id,
		token: resumed.token,
		projectId,
		event: "run",
	});
	await updateBatch({
		id: resumed.run.id,
		token: resumed.token,
		projectId,
		event: "complete",
	});
	await expect(
		createProjectEdit({ ...input, id: "old-checkpoint" }),
	).rejects.toThrow("latest failed");
});

test("an existing project whose worker never started cancels immediately and rejects late writes", async () => {
	const projectId = "lost-before-start";
	const stamp = "2026-10-08T10:00:00.000Z";
	projects.set(projectId, {
		metadata: { name: "Lost worker", updatedAt: stamp },
	});
	const started = await createProjectEdit({
		id: "lost-worker-run",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	const cancelled = await cancelBatch({ id: started.run.id });
	expect(
		cancelled.runs.find((r) => r.id === started.run.id)?.jobs[0].status,
	).toBe("cancelled");
	await assertBatchProjectWrite({ projectId, token: null });
	await expect(
		assertBatchProjectWrite({ projectId, token: started.token }),
	).rejects.toThrow("Expired");
	await expect(
		updateBatch({
			id: started.run.id,
			token: started.token,
			projectId,
			event: "run",
		}),
	).rejects.toThrow();
	expect(projects.get(projectId)?.metadata.updatedAt).toBe(stamp);
	const retry = await createProjectEdit({
		id: "replacement-worker-run",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	await updateBatch({
		id: retry.run.id,
		token: retry.token,
		projectId,
		event: "run",
	});
	const cancelling = await cancelBatch({ id: retry.run.id });
	expect(
		cancelling.runs.find((r) => r.id === retry.run.id)?.jobs[0],
	).toMatchObject({ status: "running", cancelRequested: true });
	// Already-running workers must flush before releasing the project lock.
	await expect(
		assertBatchProjectWrite({ projectId, token: null }),
	).rejects.toThrow("locked");
	await updateBatch({
		id: retry.run.id,
		token: retry.token,
		projectId,
		event: "cancel",
	});
});

test("explicit resume after worker interruption preserves the checkpoint and fences the old worker", async () => {
	const projectId = "interrupted-resume-project";
	const stamp = "2026-10-08T10:00:00.000Z";
	projects.set(projectId, {
		metadata: { name: "Interrupted", updatedAt: stamp },
	});
	const original = await createProjectEdit({
		id: "interrupted-resume-original",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "run",
		completedStages: 3,
	});
	const path = join(root, "batch", "queue.json");
	const stored = JSON.parse(await readFile(path, "utf8"));
	stored.runs.find(
		(run: { id: string }) => run.id === original.run.id,
	).heartbeat = 0;
	await writeFile(path, JSON.stringify(stored));
	expect(
		(await getBatchState()).runs.find((r) => r.id === original.run.id)?.jobs[0]
			.status,
	).toBe("interrupted");
	const resumed = await createProjectEdit({
		id: "interrupted-resume-next",
		projectId,
		expectedUpdatedAt: stamp,
		options,
		resumeRunId: original.run.id,
	});
	expect(resumed.run.jobs[0]).toMatchObject({
		status: "ready",
		completedStages: 3,
		resumeFromStage: 3,
	});
	await expect(
		updateBatch({
			id: original.run.id,
			token: original.token,
			projectId,
			event: "complete",
		}),
	).rejects.toThrow("expired");
	await expect(
		assertBatchProjectWrite({ projectId, token: original.token }),
	).rejects.toThrow();
});

test("caption checkpoints belong to their scene and cannot skip preparation in another Smart Takes scene", async () => {
	const projectId = "scene-checkpoint-project",
		stamp = "2026-10-08T12:00:00.000Z";
	const project = {
		metadata: { name: "Scenes", updatedAt: stamp },
		currentSceneId: "smart-takes-b",
	};
	projects.set(projectId, project);
	const original = await createProjectEdit({
		id: "scene-checkpoint-original",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	expect(original.run.jobs[0].sceneId).toBe("smart-takes-b");
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "run",
		completedStages: 3,
	});
	await updateBatch({
		id: original.run.id,
		token: original.token,
		projectId,
		event: "fail",
	});
	project.currentSceneId = "smart-takes-a";
	await expect(
		createProjectEdit({
			id: "wrong-scene-resume",
			projectId,
			expectedUpdatedAt: stamp,
			options,
			resumeRunId: original.run.id,
		}),
	).rejects.toThrow("latest failed");
	const fresh = await createProjectEdit({
		id: "fresh-scene-start",
		projectId,
		expectedUpdatedAt: stamp,
		options,
	});
	expect(fresh.run.jobs[0]).toMatchObject({
		sceneId: "smart-takes-a",
		completedStages: 0,
	});
});

test("Full Auto queues freeze the account kit, reject missing kits and discard caller supplied snapshots", async () => {
	const kit = { ...newBrandKit(), name: "Client brand" };
	brandLibrary = [kit];
	const queued = await createBatch({
		id: "brand-batch",
		files: [{ projectId: "brand-project", fileName: "brand.mp4" }],
		options: {
			...options,
			brandKitId: kit.id,
			brandKit: { ...kit, name: "forged" },
			brandKitAccountId: "bob",
		},
	});
	expect(queued.run.options.brandKit).toEqual(kit);
	expect(queued.run.options.brandKitAccountId).toBe("alice");
	brandLibrary = [{ ...kit, name: "New kit version" }];
	expect(
		(await getBatchState()).runs.find((run) => run.id === queued.run.id)
			?.options.brandKit?.name,
	).toBe("Client brand");
	await expect(
		createBatch({
			id: "brand-missing",
			files: [{ projectId: "brand-missing-project", fileName: "new.mp4" }],
			options: { ...options, brandKitId: "missing" },
		}),
	).rejects.toThrow("no longer exists");
	const plain = await createBatch({
		id: "brand-none",
		files: [{ projectId: "brand-none-project", fileName: "new.mp4" }],
		options: { ...options, brandKit: kit, brandKitAccountId: "bob" },
	});
	expect(plain.run.options.brandKit).toBeUndefined();
});

test("scene queue is serial, source stays writable, reload fences old workers and resumes durable stages", async () => {
	await writeFile(join(root, "batch/queue.json"), JSON.stringify({ runs: [] }));
	const job = (id: string) => ({
		id,
		sceneId: `scene-${id}`,
		workerProjectId: `worker-${id}`,
		outputSceneId: `output-${id}`,
		action: "full-auto" as const,
		options,
		status: "queued" as const,
	});
	projects.set("source", {
		metadata: { name: "Source", updatedAt: "now" },
		automationEdits: [job("first"), job("second")],
		scenes: [
			{ id: "scene-first", name: "First scene" },
			{ id: "scene-second", name: "Second scene" },
		],
	});
	projects.set("worker-first", {
		metadata: { name: "Working", updatedAt: "now" },
		automationCheckpoint: 0,
		automationSource: {
			projectId: "source",
			jobId: "first",
			sceneId: "scene-first",
		},
	});
	projects.set("worker-second", {
		metadata: { name: "Working", updatedAt: "now" },
		automationCheckpoint: 0,
		automationSource: {
			projectId: "source",
			jobId: "second",
			sceneId: "scene-second",
		},
	});
	await createSceneEdits({
		projectId: "source",
		jobIds: ["first", "second"],
		ownerId: "tab",
	});
	await createSceneEdits({
		projectId: "source",
		jobIds: ["first", "second"],
		ownerId: "tab",
	});
	expect((await getBatchState()).runs).toHaveLength(2);
	await assertBatchProjectWrite({ projectId: "source", token: null });
	const first = await recoverSceneWorker({ ownerId: "tab" });
	expect(first?.run.id).toBe("first");
	if (!first) throw new Error("Missing worker");
	expect(await recoverSceneWorker({ ownerId: "another-tab" })).toBeNull();
	expect(
		await recoverSceneWorker({ ownerId: "tab", activeRunId: "first" }),
	).toBeNull();
	await updateBatch({
		id: "first",
		token: first.token,
		projectId: "worker-first",
		event: "run",
	});
	projects.get("worker-first")!.automationCheckpoint = 2;
	const reloaded = await recoverSceneWorker({ ownerId: "tab" });
	expect(reloaded?.run.jobs[0].resumeFromStage).toBe(2);
	expect(reloaded?.token).not.toBe(first.token);
	await expect(
		updateBatch({
			id: "first",
			token: first.token,
			projectId: "worker-first",
			event: "complete",
		}),
	).rejects.toThrow("expired");
	if (!reloaded) throw new Error("Missing recovered worker");
	await expect(
		assertBatchProjectWrite({
			projectId: "worker-second",
			token: reloaded.token,
		}),
	).rejects.toThrow("Expired");
	await updateBatch({
		id: "first",
		token: reloaded.token,
		projectId: "worker-first",
		event: "run",
	});
	await updateBatch({
		id: "first",
		token: reloaded.token,
		projectId: "worker-first",
		event: "complete",
	});
	const second = await recoverSceneWorker({ ownerId: "tab" });
	expect(second?.run.id).toBe("second");
	if (!second) throw new Error("Missing second worker");
	await updateBatch({
		id: "second",
		token: second.token,
		projectId: "worker-second",
		event: "run",
	});
	projects.get("worker-second")!.automationCheckpoint = 4;
	await updateBatch({
		id: "second",
		token: second.token,
		projectId: "worker-second",
		event: "fail",
	});
	await retrySceneEdit({ id: "second", ownerId: "tab" });
	const retry = await recoverSceneWorker({ ownerId: "tab" });
	expect(retry?.run.jobs[0].resumeFromStage).toBe(4);
	await cancelBatch({ id: "second" });
	expect(
		(await getBatchState()).runs.find((r) => r.id === "second")?.jobs[0].status,
	).toBe("cancelled");
	await assertBatchProjectWrite({ projectId: "source", token: null });
});

test("retrying an older stopped job does not preempt an already-dispatched scene", async () => {
	await writeFile(join(root, "batch/queue.json"), JSON.stringify({ runs: [] }));
	await createSceneEdits({
		projectId: "source",
		jobIds: ["first", "second"],
		ownerId: "tab",
	});
	const first = await recoverSceneWorker({ ownerId: "tab" });
	if (!first) throw Error("No first worker");
	await updateBatch({
		id: "first",
		token: first.token,
		projectId: "worker-first",
		event: "fail",
	});
	const second = await recoverSceneWorker({ ownerId: "tab" });
	expect(second?.run.id).toBe("second");
	await retrySceneEdit({ id: "first", ownerId: "tab" });
	expect((await getBatchState()).executionRunId).toBe("second");
	expect(
		await recoverSceneWorker({ ownerId: "tab", activeRunId: "second" }),
	).toBeNull();
	await cancelBatch({ id: "first" });
	await cancelBatch({ id: "second" });
});

test("independent windows do not steal a live executor and editor reload cannot fence it", async () => {
	await writeFile(join(root, "batch/queue.json"), JSON.stringify({ runs: [] }));
	await createSceneEdits({
		projectId: "source",
		jobIds: ["first", "second"],
		ownerId: "tab",
	});
	const first = await recoverSceneWorker({
		ownerId: "tab",
		executor: "window",
		workerId: "worker-window-a",
	});
	if (!first) throw Error("No runner");
	// A background window can deliver delayed heartbeats; protect its full lease.
	const journalPath = join(root, "batch/queue.json");
	const journal = JSON.parse(await readFile(journalPath, "utf8"));
	journal.runs.find(
		(run: { id: string }) => run.id === "first",
	).workerHeartbeatAt = Date.now() - 90_000;
	await writeFile(journalPath, JSON.stringify(journal));
	expect(
		await recoverSceneWorker({ ownerId: "tab", executor: "iframe" }),
	).toBeNull();
	expect(
		await recoverSceneWorker({
			ownerId: "tab",
			executor: "window",
			workerId: "worker-window-b",
		}),
	).toBeNull();
	await updateBatch({
		id: first.run.id,
		token: first.token,
		projectId: "worker-first",
		event: "run",
	});
	await updateBatch({
		id: first.run.id,
		token: first.token,
		projectId: "worker-first",
		event: "complete",
	});
	const second = await recoverSceneWorker({
		ownerId: "tab",
		executor: "window",
		workerId: "worker-window-a",
	});
	expect(second?.run.id).toBe("second");
	await cancelBatch({ id: "second" });
});

test("waiting scene jobs never expire while a long edit is executing", async () => {
	await writeFile(join(root, "batch/queue.json"), JSON.stringify({ runs: [] }));
	await createSceneEdits({
		projectId: "source",
		jobIds: ["first", "second"],
		ownerId: "tab",
	});
	const first = await recoverSceneWorker({
		ownerId: "tab",
		workerId: "runner",
	});
	if (!first) throw Error("Missing worker");
	await updateBatch({
		id: "first",
		token: first.token,
		projectId: "worker-first",
		event: "run",
	});
	const path = join(root, "batch/queue.json");
	const stored = JSON.parse(await readFile(path, "utf8"));
	for (const run of stored.runs) run.heartbeat = Date.now() - 600_000;
	await writeFile(path, JSON.stringify(stored));
	const state = await getBatchState();
	expect(state.runs.find((r) => r.id === "first")?.jobs[0].status).toBe(
		"interrupted",
	);
	expect(state.runs.find((r) => r.id === "second")?.jobs[0].status).toBe(
		"ready",
	);
	await cancelBatch({ id: "first" });
	await cancelBatch({ id: "second" });
});

test("MCP scene jobs launch and resume through the existing iframe executor", async () => {
	await writeFile(join(root, "batch/queue.json"), JSON.stringify({ runs: [] }));
	const id = "mcp-earshot";
	projects.set("mcp-source", {
		metadata: { name: "MCP source", updatedAt: "now" },
		automationEdits: [
			{
				id,
				sceneId: "mcp-scene",
				workerProjectId: "mcp-worker",
				outputSceneId: "mcp-output",
				action: "sound-effects",
				options: { ...options, soundEffects: true },
				status: "queued",
			},
		],
		scenes: [{ id: "mcp-scene", name: "Earshot" }],
	});
	projects.set("mcp-worker", {
		metadata: { name: "Worker", updatedAt: "now" },
		automationSource: {
			projectId: "mcp-source",
			jobId: id,
			sceneId: "mcp-scene",
		},
		automationCheckpoint: 0,
	});
	await createSceneEdits({
		projectId: "mcp-source",
		jobIds: [id],
		ownerId: "mcp-tab",
		executor: "iframe",
	});
	await createSceneEdits({
		projectId: "mcp-source",
		jobIds: [id],
		ownerId: "mcp-tab",
		executor: "iframe",
	});
	expect((await getBatchState()).runs).toHaveLength(1);
	expect(
		await recoverSceneWorker({ ownerId: "mcp-tab", executor: "window" }),
	).toBeNull();
	const worker = await recoverSceneWorker({
		ownerId: "mcp-tab",
		executor: "iframe",
	});
	if (!worker) throw new Error("Missing iframe worker");
	expect(worker.run.options.soundEffects).toBe(true);
	expect(worker.run.jobs[0].action).toBe("sound-effects");
	projects.get("mcp-worker")!.automationCheckpoint = 1;
	await updateBatch({
		id,
		token: worker.token,
		projectId: "mcp-worker",
		event: "fail",
	});
	await retrySceneEdit({ id, ownerId: "mcp-tab", executor: "iframe" });
	expect(
		(await recoverSceneWorker({ ownerId: "mcp-tab", executor: "iframe" }))?.run
			.jobs[0].resumeFromStage,
	).toBe(1);
	await cancelBatch({ id });
});
