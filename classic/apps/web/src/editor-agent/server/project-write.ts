import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { requireAccount } from "@/accounts/server";
import {
	EDITOR_SESSION_FIELD,
	replaceProjectRecord,
	withProjectStorageLock,
} from "@/services/local-drive/project-transaction";
import { SessionRejected } from "./session-store";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const authoritySchema = z.object({
	projectId: id,
	sessionId: id,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
interface WriteRequest {
	signal: AbortSignal;
	authority: z.infer<typeof authoritySchema> | null;
	batchToken: string | null;
}
const requestScope = new AsyncLocalStorage<WriteRequest>();

/** Called inside withAccount; headers carry a fence, never an account identity
 * or an extra permission. Rust compares them to the authenticated stored owner. */
export function withProjectWriteRequest<T>({
	request,
	run,
}: {
	request: Request;
	run: () => Promise<T>;
}): Promise<T> {
	const projectId = request.headers.get("X-OpenCut-Editor-Project");
	const sessionId = request.headers.get("X-OpenCut-Editor-Session");
	const generation = request.headers.get("X-OpenCut-Editor-Generation");
	const authority =
		projectId === null && sessionId === null && generation === null
			? null
			: authoritySchema.parse({
					projectId,
					sessionId,
					generation: generation === null ? undefined : Number(generation),
				});
	return requestScope.run(
		{
			authority,
			batchToken: request.headers.get("X-OpenCut-Batch-Token"),
			signal: request.signal,
		},
		run,
	);
}

/** For short publication steps only. Streaming/staging runs outside both locks.
 * Protected service entry points call this even without HTTP request context. */
export async function withEditorProjectWrite<T>({
	projectId,
	write,
}: {
	projectId: string;
	write: (context: { assertWrite: () => void }) => Promise<T>;
}): Promise<T> {
	const accountId = requireAccount().id;
	const scope = requestScope.getStore();
	if (scope?.authority && scope.authority.projectId !== projectId)
		throw new SessionRejected("Editor authority belongs to another project");
	const { withBatchProjectWrite } = await import("@/batch/server");
	return withBatchProjectWrite({
		projectId,
		token: scope?.batchToken ?? null,
		write: ({ assertLock: assertBatchLock }) =>
			withProjectStorageLock({
				projectId,
				write: async ({ path, assertLock }) => {
					const project = await readFile(path, "utf8")
						.then((raw) =>
							z.record(z.string(), z.unknown()).parse(JSON.parse(raw)),
						)
						.catch((error: NodeJS.ErrnoException) => {
							if (error.code === "ENOENT") return null;
							throw error;
						});
					if (
						project &&
						!z.object({ id: z.literal(projectId) }).safeParse(project.metadata)
							.success
					)
						throw new SessionRejected(
							"Stored project identity does not match its directory",
						);
					const previous = project?.[EDITOR_SESSION_FIELD];
					if (previous !== undefined && typeof previous !== "string")
						throw new SessionRejected("Unsupported editor session record");
					const { sessionStoreTransition } =
						await import("opencut-editor-runtime-wasm");
					const request = {
						type: "assertWrite",
						sessionId: scope?.authority?.sessionId ?? null,
						generation: scope?.authority?.generation ?? null,
					};
					let record = previous ?? "";
					const assertWrite = () => {
						scope?.signal.throwIfAborted();
						assertBatchLock();
						assertLock();
						try {
							const next = z
								.object({ record: z.string() })
								.parse(
									sessionStoreTransition(
										record,
										accountId,
										projectId,
										request,
										Date.now(),
									),
								);
							record = next.record;
						} catch (error) {
							throw new SessionRejected(
								error instanceof Error ? error.message : String(error),
							);
						}
					};
					assertWrite();
					// Keep monotonic observed host time for adopted sessions. Merely writing
					// legacy assets must not adopt an unsaved legacy project.
					if (project && previous !== undefined && record !== previous)
						await replaceProjectRecord({
							path,
							value: { ...project, [EDITOR_SESSION_FIELD]: record },
							assertLock: assertWrite,
						});
					return write({ assertWrite });
				},
			}),
	});
}
