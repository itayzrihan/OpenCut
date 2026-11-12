/** Narrow nonsecret IO gateway. There is deliberately no approval operation. */
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import * as store from "./store";
import * as provider from "./provider";
import * as batches from "./batch";
import { probeReference } from "./probe";
import type { DirectorJob } from "../types";
const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const operation = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("importReference"),
			name: z.string().min(1).max(300),
			mime: z.string().max(100),
			dataBase64: z.string().min(4).max(16_777_216),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
			storyboard: z.boolean().default(false),
		})
		.strict(),
	z
		.object({
			type: z.literal("prepare"),
			kind: z.enum(["video", "storyboard"]),
			model: z.string().min(1).max(200),
			prompt: z.string().min(20).max(100_000),
			duration: z.number().int().min(1).max(120).nullish(),
			resolution: z.string().min(1).max(30).nullish(),
			aspectRatio: z
				.enum(["9:16", "16:9", "4:3", "3:4", "1:1", "21:9"])
				.nullish(),
			referenceIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(12),
			httpsReferences: z.record(z.string(), z.string().url()).default({}),
		})
		.strict(),
	z
		.object({
			type: z.literal("prepareChapters"),
			planId: operationId,
			plan: z
				.object({
					id: operationId,
					title: z.string().max(200),
					version: z.number().int().positive(),
					model: z.string().max(200),
					resolution: z.string().max(30),
					aspectRatio: z.string().max(30),
					chapters: z
						.array(
							z
								.object({
									id: operationId,
									title: z.string().max(200),
									prompt: z.string().max(100000),
									duration: z.number().int().min(1).max(120),
									sourceStartMs: z
										.number()
										.int()
										.nonnegative()
										.max(86400000)
										.optional(),
									sourceEndMs: z
										.number()
										.int()
										.positive()
										.max(86400000)
										.optional(),
									timingEstimated: z.boolean().optional(),
								})
								.passthrough(),
						)
						.min(1)
						.max(200),
					references: z
						.array(
							z
								.object({ referenceId: z.string().regex(/^[a-f0-9]{32}$/) })
								.passthrough(),
						)
						.max(12),
				})
				.passthrough(),
		})
		.strict(),
	z.object({ type: z.literal("status") }).strict(),
]);
export const mcpInput = z
	.object({
		projectId: z.string().min(1).max(256),
		expectedRevision: z.number().int().nonnegative(),
		operationId,
		operation,
	})
	.strict();
const link = (j: DirectorJob) => ({
	id: j.id,
	digest: j.digest,
	status: j.status,
	mediaId: null,
});
/** Exclusive durable reservation: an interrupted operation is reconciled, never retried implicitly. */
export async function mcpRequest({
	root,
	raw,
	referenceUrl,
	net = fetch,
}: {
	root: string;
	raw: unknown;
	referenceUrl: Parameters<typeof provider.prepare>[0]["referenceUrl"];
	net?: provider.Fetcher;
}) {
	const i = mcpInput.parse(raw);
	store.validProject(i.projectId);
	const base = {
		projectId: i.projectId,
		revision: i.expectedRevision,
		reference: null,
		job: null,
		jobs: [],
	};
	if (i.operation.type === "status")
		return {
			...base,
			jobs: (await store.jobs({ root, projectId: i.projectId }))
				.slice(0, 200)
				.map(link),
		};
	const directory = join(root, "mcp-operations");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const key = store.sha(i.projectId + "\n" + i.operationId),
		file = join(directory, key + ".json"),
		fingerprint = store.sha(
			JSON.stringify({ projectId: i.projectId, operation: i.operation }),
		);
	try {
		await writeFile(file, JSON.stringify({ fingerprint, state: "reserved" }), {
			flag: "wx",
			mode: 0o600,
		});
	} catch (e) {
		if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
		const old = JSON.parse(await readFile(file, "utf8"));
		if (old.fingerprint !== fingerprint)
			throw new Error("operationId already belongs to a different request");
		if (old.state !== "complete")
			throw new Error(
				"Operation is pending or interrupted. Inspect existing POCUT references/reviews before retrying; no paid call was made.",
			);
		return { ...old.result, revision: i.expectedRevision };
	}
	let result: Record<string, unknown>;
	if (i.operation.type === "importReference") {
		const { dataBase64, sha256, mime, name, storyboard } = i.operation;
		const bytes = Buffer.from(dataBase64, "base64");
		if (
			!bytes.length ||
			bytes.length > 12 * 1024 * 1024 ||
			bytes.toString("base64") !== dataBase64 ||
			store.sha(bytes) !== sha256
		)
			throw new Error(
				"Reference must be canonical base64, at most12MiB, and match original SHA256",
			);
		if (storyboard && !mime.startsWith("image/"))
			throw new Error("A physical storyboard must be an image");
		const reference = await store.artifact({
			root,
			projectId: i.projectId,
			name,
			mime,
			bytes,
			storyboard,
		});
		await probeReference({ root, projectId: i.projectId, id: reference.id });
		result = { ...base, reference };
	} else if (i.operation.type === "prepareChapters") {
		const plan = i.operation.plan;
		if (plan.id !== i.operation.planId)
			throw new Error("Chapter plan identity mismatch");
		const jobs: DirectorJob[] = [];
		for (const [index, chapter] of plan.chapters.entries())
			jobs.push(
				await provider.prepare({
					root,
					net,
					referenceUrl,
					raw: {
						projectId: i.projectId,
						operationId: store.sha(i.operationId + ":" + index),
						kind: "video",
						model: plan.model,
						resolution: plan.resolution,
						aspectRatio: plan.aspectRatio,
						duration: chapter.duration,
						prompt: chapter.prompt,
						videoMode: plan.references.length ? "references" : "text",
						referenceIds: plan.references.map((r) => r.referenceId),
						chapter: {
							planId: plan.id,
							planVersion: plan.version,
							chapterId: chapter.id,
							index,
							total: plan.chapters.length,
							title: chapter.title,
							sourceStartMs: chapter.sourceStartMs,
							sourceEndMs: chapter.sourceEndMs,
							timingEstimated: chapter.timingEstimated,
						},
					},
				}),
			);
		const batch = await batches.prepareBatch({
			root,
			projectId: i.projectId,
			raw: {
				id: store.sha(i.projectId + ":" + i.operationId).slice(0, 32),
				kind: "chapters",
				jobs: jobs.map((j) => ({ id: j.id, digest: j.digest })),
			},
		});
		result = {
			...base,
			jobs: jobs.map(link),
			batch: {
				id: batch.id,
				planId: plan.id,
				version: plan.version,
				jobIds: jobs.map((j) => j.id),
			},
		};
	} else {
		const { type, ...request } = i.operation;
		void type;
		const job = await provider.prepare({
			root,
			net,
			raw: {
				...request,
				projectId: i.projectId,
				duration: request.duration ?? undefined,
				resolution: request.resolution ?? undefined,
				aspectRatio: request.aspectRatio ?? undefined,
			},
			referenceUrl,
		});
		result = { ...base, job: link(job) };
	}
	await store.saveJson({
		root: directory,
		name: key + ".json",
		value: { fingerprint, state: "complete", result },
	});
	return result;
}
