import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { listProjectMetadata } from "@/services/local-drive/server";

const resultSchema = z.object({
	store: z.string().max(8_000_000),
	result: z.object({
		revision: z.number().int().nonnegative(),
		changed: z.boolean(),
		data: z.unknown(),
	}),
});

/** Definitive policy/schema rejection before any durable write. Other errors
 * may have occurred after rename and must be reconciled with the same key. */
export class KnowledgeRejected extends Error {}

/** Filesystem adapter only. Rust owns scope, versions, overrides, idempotency,
 * search and quota rules. All paths originate in the authenticated account. */
export async function operateKnowledge({
	projectId,
	request,
}: {
	projectId: string;
	request: unknown;
}) {
	const owner = requireAccount().id;
	const projects = await listProjectMetadata();
	const owned = projects.flatMap((project) =>
		typeof project.id === "string" ? [project.id] : [],
	);
	if (!owned.includes(projectId))
		throw new KnowledgeRejected(
			"Open an owned project before accessing its knowledge",
		);
	const directory = join(accountDataRoot(), "editor-agent", "knowledge");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let compromised = false;
	const release = await lockfile.lock(directory, {
		realpath: false,
		stale: 60_000,
		update: 10_000,
		retries: { retries: 20, minTimeout: 100, maxTimeout: 500 },
		onCompromised: () => {
			compromised = true;
		},
	});
	const assertLock = () => {
		if (compromised) throw new Error("Knowledge storage lock was lost");
	};
	try {
		const path = join(directory, "knowledge.json");
		let saved = "";
		try {
			saved = await readFile(path, "utf8");
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		assertLock();
		const { knowledgeDispatch } = await import("opencut-editor-runtime-wasm");
		let result: z.infer<typeof resultSchema>;
		try {
			result = resultSchema.parse(
				knowledgeDispatch(saved, owner, projectId, owned, request, Date.now()),
			);
		} catch (error) {
			throw new KnowledgeRejected(
				error instanceof Error ? error.message : String(error),
			);
		}
		if (result.result.changed) {
			const temp = join(directory, `knowledge-${randomUUID()}.tmp`);
			try {
				await writeFile(temp, result.store, { flag: "wx", mode: 0o600 });
				assertLock();
				await rename(temp, path);
			} finally {
				await unlink(temp).catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENOENT") throw error;
				});
			}
		}
		return result.result;
	} finally {
		await release();
	}
}
