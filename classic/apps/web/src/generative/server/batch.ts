/** Durable transport ledger for explicitly approved frozen requests, never editor state. */
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import * as store from "./store";
import * as vault from "./vault";
import * as provider from "./provider";
import type { DirectorJob, DirectorBatch } from "../types";

const jobRef = z
	.object({
		id: z.string().regex(/^[a-f0-9]{32}$/),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const inputSchema = z
	.object({
		id: z.string().regex(/^[a-f0-9]{32}$/),
		kind: z.enum(["chapters", "seamless", "images"]),
		jobs: z.array(jobRef).min(1).max(200),
	})
	.strict();
const folder = ({ root, id }: { root: string; id: string }) =>
	join(root, "batches", store.validId(id));
async function cancelled(path: string) {
	try {
		await access(join(path, "cancelled"));
		return true;
	} catch {
		return false;
	}
}
export async function readBatch({
	root,
	projectId,
	id,
}: {
	root: string;
	projectId: string;
	id: string;
}) {
	const batch = await store.json<DirectorBatch>({
		root: folder({ root, id }),
		name: "batch.json",
	});
	if (batch.projectId !== projectId)
		throw new Error("Batch belongs to another project");
	if (await cancelled(folder({ root, id }))) batch.status = "cancelled";
	else if (
		batch.status === "running" &&
		!(await lockfile.check(join(folder({ root, id }), "worker"), {
			realpath: false,
			stale: 30000,
		}))
	) {
		batch.status = "paused";
		batch.message =
			"The worker stopped. Existing submissions are never repeated. Review and unlock to resume remaining requests.";
	}
	return batch;
}
export async function prepareBatch({
	root,
	projectId,
	raw,
}: {
	root: string;
	projectId: string;
	raw: unknown;
}) {
	const input = inputSchema.parse(raw);
	if (input.kind !== "chapters" && input.jobs.length > 10)
		throw new Error("Prepare at most ten requests per image or Seamless batch");
	if (new Set(input.jobs.map((j) => j.id)).size !== input.jobs.length)
		throw new Error("A batch cannot submit the same job twice");
	const digest = store.sha(
		JSON.stringify({ projectId, kind: input.kind, jobs: input.jobs }),
	);
	const path = folder({ root, id: input.id });
	await mkdir(path, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(path, { realpath: false, retries: 3 });
	try {
		try {
			const existing = await readBatch({ root, projectId, id: input.id });
			if (existing.digest !== digest)
				throw new Error("Batch ID was already used for another request");
			return existing;
		} catch (e) {
			if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
		}
		for (const item of input.jobs) {
			const job = await store.json<DirectorJob>({
				root: store.jobRoot({ root, jobId: item.id }),
				name: "review.json",
			});
			if (
				(job.batchId && job.batchId !== input.id) ||
				job.projectId !== projectId ||
				job.digest !== item.digest ||
				job.status !== "review" ||
				job.provider ||
				job.kind !== (input.kind === "images" ? "storyboard" : "video") ||
				(input.kind === "seamless" && !job.seamless)
			)
				throw new Error(
					"Batch requests must match the exact pending video reviews",
				);
		}
		const batch: DirectorBatch = {
			...input,
			projectId,
			digest,
			createdAt: Date.now(),
			status: "review",
			message:
				"Review every request. Approval sends up to three generations concurrently.",
		};
		await store.saveJson({ root: path, name: "batch.json", value: batch });
		for (const item of batch.jobs) {
			const directory = store.jobRoot({ root, jobId: item.id });
			const job = await store.json<DirectorJob>({
				root: directory,
				name: "review.json",
			});
			if (job.batchId && job.batchId !== batch.id)
				throw new Error("Request already belongs to another batch");
			job.batchId = batch.id;
			await store.saveJson({
				root: directory,
				name: "review.json",
				value: job,
			});
		}
		return batch;
	} finally {
		await release();
	}
}
export async function cancelBatch({
	root,
	projectId,
	id,
}: {
	root: string;
	projectId: string;
	id: string;
}) {
	const batch = await readBatch({ root, projectId, id });
	const path = folder({ root, id });
	await writeFile(join(path, "cancelled"), "cancel unsent requests", {
		mode: 0o600,
	});
	batch.status = "cancelled";
	batch.message =
		"Unsent requests cancelled. Accepted provider jobs may finish and remain billable.";
	await store.saveJson({ root: path, name: "batch.json", value: batch });
	return batch;
}
export async function approveBatch({
	root,
	projectId,
	id,
	digest,
	pin,
	confirmed,
	net = fetch,
	wait = false,
}: {
	root: string;
	projectId: string;
	id: string;
	digest: string;
	pin: unknown;
	confirmed: boolean;
	net?: provider.Fetcher;
	wait?: boolean;
}) {
	if (!confirmed)
		throw new Error(
			"Human confirmation is required for all paid requests in this batch",
		);
	const path = folder({ root, id });
	const batch = await readBatch({ root, projectId, id });
	if (
		batch.digest !== digest ||
		store.sha(
			JSON.stringify({ projectId, kind: batch.kind, jobs: batch.jobs }),
		) !== digest
	)
		throw new Error("Frozen batch changed");
	if (await cancelled(path))
		throw new Error(
			"This batch was cancelled; no queued paid requests will resume",
		);
	if (batch.status === "complete") return batch;
	await vault.unlock({ root, pin });
	// Separate renewable worker lease permits cancellation without allowing two submitters.
	const release = await lockfile.lock(join(path, "worker"), {
		realpath: false,
		stale: 30000,
		update: 5000,
		retries: 0,
	});
	batch.status = "running";
	batch.message =
		"Generating with up to three concurrent requests. Each request is submitted at most once.";
	try {
		await store.saveJson({ root: path, name: "batch.json", value: batch });
	} catch (error) {
		await release();
		throw error;
	}
	const work = run({ root, projectId, batch, pin, net }).finally(release);
	if (wait) await work;
	else void work.catch(() => {});
	return readBatch({ root, projectId, id });
}
async function run({
	root,
	projectId,
	batch,
	pin,
	net,
}: {
	root: string;
	projectId: string;
	batch: DirectorBatch;
	pin: unknown;
	net: provider.Fetcher;
}) {
	const path = folder({ root, id: batch.id });
	let cursor = 0;
	let failed = false;
	try {
		// Recover all accepted jobs before dispatching any unsent work. A restarted
		// worker must not create another three in-flight requests beside the old three.
		await provider.resume({ root, projectId, net });
		for (const item of batch.jobs) {
			let previous = await store.json<DirectorJob>({
				root: store.jobRoot({ root, jobId: item.id }),
				name: "review.json",
			});
			while (
				["submitting", "pending", "processing"].includes(previous.status)
			) {
				if ((await cancelled(path)) || vault.seconds(root) <= 0) {
					failed = true;
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
				previous = await store.json<DirectorJob>({
					root: store.jobRoot({ root, jobId: item.id }),
					name: "review.json",
				});
			}
			if (
				previous.status === "uncertain" ||
				previous.status === "session_expired" ||
				(previous.status === "error" &&
					previous.providerId &&
					!["failed", "cancelled", "expired"].includes(
						previous.providerStatus ?? "",
					))
			) {
				failed = true;
				return;
			}
		}
		const worker = async () => {
			for (;;) {
				if ((await cancelled(path)) || vault.seconds(root) <= 0) {
					failed = true;
					return;
				}
				const item = batch.jobs[cursor++];
				if (!item) return;
				try {
					let job = await store.json<DirectorJob>({
						root: store.jobRoot({ root, jobId: item.id }),
						name: "review.json",
					});
					if (job.projectId !== projectId || job.digest !== item.digest)
						throw new Error("Batch job changed");
					if (job.status === "review")
						job = await provider.approve({
							root,
							projectId,
							jobId: job.id,
							digest: item.digest,
							pin,
							net,
							waitForCompletion: true,
						});
					// Never resubmit uncertain/submitted jobs, including after a server restart.
					if (job.status !== "ready") failed = true;
				} catch {
					failed = true;
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(3, batch.jobs.length) }, () => worker()),
		);
	} finally {
		const stopped = await cancelled(path);
		batch.status = stopped ? "cancelled" : failed ? "paused" : "complete";
		batch.message = stopped
			? "Unsent requests cancelled. Already accepted jobs can still finish."
			: failed
				? "Some jobs need attention. Existing paid submissions will not be repeated. Unlock to resume free status checks; review remaining unsent requests before approving again."
				: "All requests are ready.";
		await store.saveJson({ root: path, name: "batch.json", value: batch });
	}
}
