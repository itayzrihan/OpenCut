/** Classic host queue. Editing always happens through the canonical EditorCore worker. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
	batchEditIsLocked,
	batchEditTransition,
	fullAutoEditStages,
} from "opencut-wasm";
import { getLocalDriveStatus, getProject } from "@/services/local-drive/server";
import type { BatchRun, BatchState, BatchJobStatus } from "./types";
import { findSceneCheckpoint } from "./scene-checkpoint";
import type { FullAutoOptions } from "@/ai/full-auto-edit";
type StoredRun = BatchRun & { token: string; heartbeat: number };
type Store = { runs: StoredRun[] };
const host = globalThis as typeof globalThis & {
	__opencutBatchQueues?: Map<string, Promise<unknown>>;
};
const queues = (host.__opencutBatchQueues ??= new Map<
	string,
	Promise<unknown>
>());
const leaseMs = 180_000;
async function transaction<T>(
	action: (store: Store, assertLock: () => void) => Promise<T> | T,
): Promise<T> {
	// Resolve the authenticated account before queuing. Other accounts have
	// independent queues; another server process uses the same filesystem lock.
	const root = join((await getLocalDriveStatus()).rootPath, "batch");
	const pending = (queues.get(root) ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			const path = join(root, "queue.json");
			await mkdir(root, { recursive: true, mode: 0o700 });
			let compromised = false;
			const release = await lockfile.lock(root, {
				realpath: false,
				stale: 60_000,
				update: 10_000,
				retries: { retries: 120, minTimeout: 50, maxTimeout: 500 },
				onCompromised: () => {
					compromised = true;
				},
			});
			const assertLock = () => {
				if (compromised)
					throw new Error(
						"Batch storage lock was lost; reconcile the last operation",
					);
			};
			try {
				const store: Store = await readFile(path, "utf8")
					.then(JSON.parse)
					.catch((e) => {
						if (e.code === "ENOENT") return { runs: [] };
						throw e;
					});
				const original = JSON.stringify(store);
				for (const run of store.runs)
					if (Date.now() - run.heartbeat > leaseMs) {
						for (const job of run.jobs)
							if (batchEditIsLocked({ status: job.status })) {
								job.status = batchEditTransition({
									status: job.status,
									event: "interrupt",
								}) as BatchJobStatus;
								job.message =
									"Worker disconnected. Completed edits were preserved; caption and finishing stages can be resumed from the editor.";
								run.updatedAt = Date.now();
							}
					}
				const result = await action(store, assertLock);
				assertLock();
				if (JSON.stringify(store) === original) return result;
				const temp = join(root, `queue-${randomUUID()}.tmp`);
				try {
					const file = await open(temp, "wx", 0o600);
					try {
						await file.writeFile(JSON.stringify(store));
						await file.sync();
					} finally {
						await file.close();
					}
					assertLock();
					await rename(temp, path);
				} finally {
					await unlink(temp).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				}
				return result;
			} finally {
				await release();
			}
		});
	queues.set(root, pending);
	try {
		return await pending;
	} finally {
		if (queues.get(root) === pending) queues.delete(root);
	}
}
const publicState = (s: Store): BatchState => ({
	executionRunId: [...s.runs]
		.reverse()
		.find((r) => r.jobs.some((j) => batchEditIsLocked({ status: j.status })))
		?.id,
	runs: s.runs.map(({ token: _token, heartbeat: _heartbeat, ...run }) => run),
});
function retainRuns(runs: StoredRun[]) {
	let completed = 0;
	return runs.filter(
		(r) =>
			r.jobs.some((j) => batchEditIsLocked({ status: j.status })) ||
			completed++ < 20,
	);
}
export async function createProjectEdit({
	id,
	projectId,
	expectedUpdatedAt,
	resumeRunId,
	options,
}: {
	id: string;
	projectId: string;
	expectedUpdatedAt: string;
	resumeRunId?: string;
	options: FullAutoOptions;
}) {
	return transaction(async (s) => {
		const replay = s.runs.find((r) => r.id === id);
		if (replay) throw new Error("This edit was already submitted");
		if (
			s.runs.some((r) =>
				r.jobs.some(
					(j) =>
						j.projectId === projectId &&
						batchEditIsLocked({ status: j.status }),
				),
			)
		)
			throw new Error("This project already has an active automatic edit");
		const project = (await getProject(projectId)) as {
			metadata?: { name?: string; updatedAt?: string };
			currentSceneId?: string;
		} | null;
		if (!project?.metadata)
			throw new Error(
				"Save the imported project before starting automatic editing",
			);
		if (project.metadata.updatedAt !== expectedUpdatedAt)
			throw new Error("Project changed before handoff. Save and try again.");
		let resumeFromStage = 0;
		if (resumeRunId) {
			const previous = findSceneCheckpoint({
				runs: s.runs,
				projectId,
				sceneId: project.currentSceneId,
			});
			const job = previous?.jobs.find((j) => j.projectId === projectId);
			if (
				previous?.id !== resumeRunId ||
				(job?.status !== "failed" && job?.status !== "interrupted") ||
				job.completedStages < 3 ||
				job.completedStages >= fullAutoEditStages(previous.options).length
			)
				throw new Error(
					"Only the latest failed or interrupted caption or finishing stage can be resumed",
				);
			for (const key of [
				"zoom",
				"transitions",
				"wordAnimation",
				"music",
			] as const)
				if (options[key] !== previous.options[key])
					throw new Error("Resume must preserve the original recipe");
			resumeFromStage = job.completedStages;
		}
		const run: StoredRun = {
			id,
			kind: "single",
			createdAt: Date.now(),
			options,
			token: randomUUID(),
			heartbeat: Date.now(),
			updatedAt: Date.now(),
			jobs: [
				{
					projectId,
					...(project.currentSceneId
						? { sceneId: project.currentSceneId }
						: {}),
					name: project.metadata.name ?? "Project",
					fileName: project.metadata.name ?? "Project",
					source: "existing",
					status: "ready",
					message: resumeRunId
						? `Queued to resume Full Auto Edit from stage ${resumeFromStage + 1}`
						: "Queued for background Full Auto Edit",
					cancelRequested: false,
					created: true,
					completedStages: resumeFromStage,
					...(resumeRunId ? { resumeFromStage } : {}),
				},
			],
		};
		s.runs = retainRuns([run, ...s.runs]);
		return { token: run.token, run: publicState({ runs: [run] }).runs[0] };
	});
}
export const getBatchState = () => transaction(publicState);
export async function createBatch({
	id,
	files,
	options,
}: {
	id: string;
	files: { projectId: string; fileName: string }[];
	options: FullAutoOptions;
}) {
	return transaction(async (s) => {
		if (s.runs.some((r) => r.id === id))
			throw new Error("This batch was already submitted");
		const reserved = new Set(
			s.runs.flatMap((r) => r.jobs.map((j) => j.projectId)),
		);
		for (const f of files) {
			if (reserved.has(f.projectId) || (await getProject(f.projectId)))
				throw new Error("Batch requires new project ids");
			reserved.add(f.projectId);
		}
		const run: StoredRun = {
			id,
			kind: "batch",
			createdAt: Date.now(),
			options,
			token: randomUUID(),
			heartbeat: Date.now(),
			updatedAt: Date.now(),
			jobs: files.map((f) => ({
				...f,
				name: f.fileName.replace(/\.[^.]+$/, "") + " - Auto Edit",
				status: "queued",
				message: "Waiting to import",
				cancelRequested: false,
				created: false,
				completedStages: 0,
			})),
		};
		s.runs = retainRuns([run, ...s.runs]);
		return { token: run.token, run: publicState({ runs: [run] }).runs[0] };
	});
}
export async function updateBatch({
	id,
	token,
	projectId,
	event,
	message,
	created,
	completedStages,
}: {
	id: string;
	token: string;
	projectId?: string;
	event?: string;
	message?: string;
	created?: boolean;
	completedStages?: number;
}) {
	return transaction((s) => {
		const run = s.runs.find((r) => r.id === id && r.token === token);
		if (!run || !run.jobs.some((j) => batchEditIsLocked({ status: j.status })))
			throw new Error("Batch write lease expired or finished");
		if (projectId) {
			const job = run.jobs.find((j) => j.projectId === projectId);
			if (!job || !batchEditIsLocked({ status: job.status }))
				throw new Error("Job is no longer writable");
			if (event) {
				const status = batchEditTransition({ status: job.status, event });
				if (!status) throw new Error("Invalid batch job transition");
				job.status = status as BatchJobStatus;
			}
			if (message !== undefined) job.message = message;
			if (created) job.created = true;
			if (completedStages !== undefined) {
				const total = fullAutoEditStages(run.options).length;
				if (
					completedStages < (job.completedStages ?? 0) ||
					completedStages > total
				)
					throw new Error("Invalid stage progress");
				job.completedStages = completedStages;
			}
			if (job.status === "completed")
				job.completedStages = fullAutoEditStages(run.options).length;
			run.updatedAt = Date.now();
		}
		run.heartbeat = Date.now();
		return publicState(s);
	});
}
export async function cancelBatch({
	id,
	projectId,
}: {
	id: string;
	projectId?: string;
}) {
	return transaction((s) => {
		const run = s.runs.find((r) => r.id === id);
		if (!run) throw new Error("Batch not found");
		for (const j of run.jobs)
			if (
				(!projectId || j.projectId === projectId) &&
				batchEditIsLocked({ status: j.status })
			) {
				j.cancelRequested = true;
				// Existing-source jobs cannot mutate before the ready -> run
				// transition. Cancel them even if their iframe disappeared.
				if (j.source === "existing" && j.status === "ready") {
					const status = batchEditTransition({
						status: j.status,
						event: "cancel",
					});
					if (status !== "cancelled")
						throw new Error("Invalid cancellation transition");
					j.status = status;
					j.message =
						"Cancelled before editing; the saved project was preserved.";
				}
			}
		run.updatedAt = Date.now();
		return publicState(s);
	});
}
/** A policy rejection before the write callback ran, unlike uncertain IO. */
export class BatchWriteRejected extends Error {}

function checkProjectWrite({
	s,
	projectId,
	token,
}: {
	s: Store;
	projectId: string;
	token: string | null;
}) {
	const activeRun = s.runs.find((r) =>
		r.jobs.some(
			(j) =>
				j.projectId === projectId && batchEditIsLocked({ status: j.status }),
		),
	);
	if (token && (!activeRun || activeRun.token !== token))
		throw new BatchWriteRejected("Expired batch writer; write rejected");
	if (activeRun && token !== activeRun.token)
		throw new BatchWriteRejected(
			"Project is locked while Full Auto Edit is working",
		);
}
export async function assertBatchProjectWrite({
	projectId,
	token,
}: {
	projectId: string;
	token: string | null;
}) {
	return transaction((s) => checkProjectWrite({ s, projectId, token }));
}
/** Lock order is account batch queue, then project storage. Hold the queue lock
 * across publication so enqueue in any host cannot overtake an in-flight save. */
export async function withBatchProjectWrite<T>({
	projectId,
	token,
	write,
}: {
	projectId: string;
	token: string | null;
	write: (context: { assertLock: () => void }) => Promise<T>;
}) {
	return transaction(async (s, assertLock) => {
		checkProjectWrite({ s, projectId, token });
		return await write({ assertLock });
	});
}
export async function assertNoActiveBatch() {
	const state = await getBatchState();
	if (
		state.runs.some((r) =>
			r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
		)
	)
		throw new Error("Cannot clear storage while a batch is active");
}
