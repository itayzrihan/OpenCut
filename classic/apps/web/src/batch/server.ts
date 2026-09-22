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
	runs: s.runs.map(({ token: _token, heartbeat: _heartbeat, ...run }) => run),
});
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
		if (
			s.runs.some((r) =>
				r.jobs.some((j) => batchEditIsLocked({ status: j.status })),
			)
		)
			throw new Error(
				"A batch is already running. Wait for it to finish or cancel it.",
			);
		for (const f of files)
			if (await getProject(f.projectId))
				throw new Error("Batch requires new project ids");
		const run: StoredRun = {
			id,
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
		s.runs = [run, ...s.runs].slice(0, 20);
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
export async function assertBatchProjectWrite({
	projectId,
	token,
}: {
	projectId: string;
	token: string | null;
}) {
	return transaction((s) => {
		const run = s.runs.find((r) =>
			r.jobs.some((j) => j.projectId === projectId),
		);
		const job = run?.jobs.find((j) => j.projectId === projectId);
		if (
			token &&
			(!run ||
				token !== run.token ||
				!job ||
				!batchEditIsLocked({ status: job.status }))
		)
			throw new Error("Expired batch writer; write rejected");
		if (
			job &&
			batchEditIsLocked({ status: job.status }) &&
			token !== run?.token
		)
			throw new Error("Project is locked while Full Auto Edit is working");
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
