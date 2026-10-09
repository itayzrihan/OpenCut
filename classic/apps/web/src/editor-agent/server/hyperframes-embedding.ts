import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { listProjectMetadata } from "@/services/local-drive/server";

export class EmbeddingRejected extends Error {}
const planSchema = z
	.object({
		projectId: z.string(),
		expectedRevision: z.number(),
		query: z.string(),
		normalizedQuery: z.string(),
		modelInput: z.string(),
		repository: z.literal("Xenova/bge-small-en-v1.5"),
		modelRevision: z.string().regex(/^[a-f0-9]{40}$/),
		vectorRevision: z.string(),
		dimensions: z.literal(384),
		files: z
			.array(
				z.object({
					path: z.string().regex(/^(?:onnx\/)?[a-z_.]+$/),
					bytes: z.number().int().min(1).max(35_000_000),
					sha256: z.string().regex(/^[a-f0-9]{64}$/),
				}),
			)
			.length(4),
	})
	.strict();
type Embedder = (query: string) => Promise<number[]>;
type ModelRunner = { embed: Embedder; dispose: () => Promise<void> };
type CachedRunner = {
	ready: Promise<ModelRunner>;
	users: number;
	lastUsed: number;
};
const loaders = new Map<string, CachedRunner>();
let acquisitions = Promise.resolve();

/** IO/inference only. Model identity, query normalization and ranking are Rust policy. */
export async function embedReference({
	projectId,
	request,
	signal,
}: {
	projectId: string;
	request: unknown;
	signal: AbortSignal;
}) {
	const account = requireAccount();
	signal.throwIfAborted();
	if (
		!(await listProjectMetadata()).some((project) => project.id === projectId)
	)
		throw new EmbeddingRejected(
			"Open an owned project before embedding a reference search",
		);
	const { hyperframesEmbeddingPlan } =
		await import("opencut-editor-runtime-wasm");
	let plan: z.infer<typeof planSchema>;
	try {
		plan = planSchema.parse(hyperframesEmbeddingPlan(request));
	} catch (error) {
		throw new EmbeddingRejected(String(error));
	}
	if (plan.projectId !== projectId)
		throw new EmbeddingRejected(
			"Embedding target differs from authenticated scope",
		);
	const modelRoot = join(
		accountDataRoot(),
		"models",
		"hyperframes",
		plan.modelRevision,
	);
	let release!: () => void;
	const previous = acquisitions;
	acquisitions = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	let entry: CachedRunner;
	try {
		signal.throwIfAborted();
		let found = loaders.get(modelRoot);
		if (!found) {
			// Two resident models, at most two concurrent queries per model. Evict only
			// idle runners so another account cannot dispose an in-flight inference.
			if (loaders.size >= 2) {
				const idle = [...loaders.entries()]
					.filter(([, value]) => value.users === 0)
					.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
				if (!idle)
					throw new EmbeddingRejected(
						"Local semantic inference is busy; try again or use keyword search",
					);
				loaders.delete(idle[0]);
				await (await idle[1].ready).dispose();
			}
			// Shared preparation is independent of any one request's abort. Its result
			// is released only after that request passes its current-account fence.
			const ready = (async (): Promise<ModelRunner> => {
				for (const asset of plan.files) {
					const target = join(modelRoot, asset.path);
					const valid = (bytes: Buffer) =>
						bytes.length === asset.bytes &&
						createHash("sha256").update(bytes).digest("hex") === asset.sha256;
					let cached: Buffer | undefined;
					try {
						if ((await stat(target)).size === asset.bytes)
							cached = await readFile(target);
					} catch {
						/* Missing cache downloads the pinned file. */
					}
					if (cached && valid(cached)) continue;
					const response = await fetch(
						`https://huggingface.co/${plan.repository}/resolve/${plan.modelRevision}/${asset.path}`,
						{ signal: AbortSignal.timeout(120_000) },
					);
					if (!response.ok || !response.body)
						throw new EmbeddingRejected(
							"The pinned local search model could not be downloaded",
						);
					const parts: Uint8Array[] = [];
					let size = 0;
					const reader = response.body.getReader();
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							size += value.byteLength;
							if (size > asset.bytes) {
								await reader.cancel();
								throw new EmbeddingRejected(
									"Model download exceeds its pinned size",
								);
							}
							parts.push(value);
						}
					} finally {
						reader.releaseLock();
					}
					const bytes = Buffer.concat(parts);
					if (!valid(bytes))
						throw new EmbeddingRejected(
							"Model checksum differs from the pinned index",
						);
					await mkdir(join(target, ".."), { recursive: true });
					const temporary = `${target}.${randomUUID()}.pending`;
					await writeFile(temporary, bytes, { flag: "wx" });
					await rename(temporary, target);
				}
				const { pipeline } = await import("@huggingface/transformers");
				const extractor = await pipeline("feature-extraction", modelRoot, {
					local_files_only: true,
					dtype: "q8",
					device: "cpu",
				});
				return {
					dispose: () => extractor.dispose(),
					embed: async (query) => {
						const output = await extractor(query, {
							pooling: "cls",
							normalize: true,
						});
						return Array.from(output.data, Number);
					},
				};
			})();
			found = { ready, users: 0, lastUsed: Date.now() };
			loaders.set(modelRoot, found);
			const installed = found;
			void ready.catch(() => {
				if (loaders.get(modelRoot) === installed) loaders.delete(modelRoot);
			});
		}
		entry = found;
		if (entry.users >= 2)
			throw new EmbeddingRejected(
				"Local semantic inference is busy; try again or use keyword search",
			);
		entry.users++;
	} finally {
		release();
	}
	try {
		const runner = await entry.ready;
		signal.throwIfAborted();
		const vector = await runner.embed(plan.modelInput);
		signal.throwIfAborted();
		if (
			requireAccount().id !== account.id ||
			!(await listProjectMetadata()).some((project) => project.id === projectId)
		)
			throw new EmbeddingRejected(
				"The active account or owned project changed during embedding",
			);
		return {
			query: plan.query,
			normalizedQuery: plan.normalizedQuery,
			modelRevision: plan.modelRevision,
			vectorRevision: plan.vectorRevision,
			vector,
		};
	} finally {
		entry.users--;
		entry.lastUsed = Date.now();
	}
}
