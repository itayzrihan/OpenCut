/** Classic host queue. Editing always happens through the canonical EditorCore worker. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
	batchEditIsLocked,
	batchEditTransition,
	fullAutoEditStages,
} from "opencut-wasm";
import { getLocalDriveStatus, getProject } from "@/services/local-drive/server";
import type { BatchRun, BatchState, BatchJobStatus } from "./types";
import type { FullAutoOptions } from "@/ai/full-auto-edit";
type StoredRun = BatchRun & { token: string; heartbeat: number };
type Store = { runs: StoredRun[] };
const host = globalThis as typeof globalThis & {
	__opencutBatchQueue?: Promise<unknown>;
};
const leaseMs = 180_000;
async function transaction<T>(
	action: (store: Store) => Promise<T> | T,
): Promise<T> {
	const pending = (host.__opencutBatchQueue ?? Promise.resolve())
		.catch(() => {})
		.then(async () => {
			const root = join((await getLocalDriveStatus()).rootPath, "batch");
			const path = join(root, "queue.json");
			await mkdir(root, { recursive: true });
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
								"Worker disconnected. Completed edits were preserved; review this project before restarting in a fresh project.";
							run.updatedAt = Date.now();
						}
				}
			const result = await action(store);
			if (JSON.stringify(store) === original) return result;
			const temp = join(root, `queue-${randomUUID()}.tmp`);
			await writeFile(temp, JSON.stringify(store));
			await rename(temp, path);
			return result;
		});
	host.__opencutBatchQueue = pending;
	return pending;
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
	options,
}: {
	id: string;
	projectId: string;
	expectedUpdatedAt: string;
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
		} | null;
		if (!project?.metadata)
			throw new Error(
				"Save the imported project before starting automatic editing",
			);
		if (project.metadata.updatedAt !== expectedUpdatedAt)
			throw new Error("Project changed before handoff. Save and try again.");
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
					name: project.metadata.name ?? "Project",
					fileName: project.metadata.name ?? "Project",
					source: "existing",
					status: "ready",
					message: "Queued for background Full Auto Edit",
					cancelRequested: false,
					created: true,
					completedStages: 0,
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
			)
				j.cancelRequested = true;
		run.updatedAt = Date.now();
		return publicState(s);
	});
}
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
		throw new Error("Expired batch writer; write rejected");
	if (activeRun && token !== activeRun.token)
		throw new Error("Project is locked while Full Auto Edit is working");
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
/** Hold the queue mutex across document/history writes so enqueue cannot overtake an in-flight save. */
export async function withBatchProjectWrite<T>({
	projectId,
	token,
	write,
}: {
	projectId: string;
	token: string | null;
	write: () => Promise<T>;
}) {
	return transaction(async (s) => {
		checkProjectWrite({ s, projectId, token });
		return await write();
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
