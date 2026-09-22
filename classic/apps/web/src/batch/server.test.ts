import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const projects = new Map<
	string,
	{ metadata: { name: string; updatedAt: string } }
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
