import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requireAccount } from "@/accounts/server";
import {
	withProjectStorageLock,
	EDITOR_SESSION_FIELD,
	replaceProjectRecord,
} from "@/services/local-drive/project-transaction";

export class SessionRejected extends Error {}
const storedProject = z.record(z.string(), z.unknown());
const transitionResult = z.object({
	record: z.string().max(120_000_000),
	project: storedProject.nullable(),
	result: z.unknown(),
});

/** One project.json replacement commits the project, canonical history, run
 * checkpoint, storage receipt and ownership fence together. */
export async function operateEditorSession({
	projectId,
	request,
	assertHostLock = () => {},
}: {
	projectId: string;
	request: unknown;
	/** The outer batch transaction must still own its lock at publication. */
	assertHostLock?: () => void;
}): Promise<
	Record<string, unknown> & {
		legacyProject: Record<string, unknown> | null;
		legacyHistory: unknown;
	}
> {
	const accountId = requireAccount().id;
	return withProjectStorageLock({
		projectId,
		write: async ({ directory, path, assertLock }) => {
			assertHostLock();
			const project = storedProject.parse(
				JSON.parse(await readFile(path, "utf8")),
			);
			if (
				z.object({ id: z.literal(projectId) }).safeParse(project.metadata)
					.success === false
			)
				throw new SessionRejected(
					"Stored project identity does not match its directory",
				);
			const previous = project[EDITOR_SESSION_FIELD];
			if (previous !== undefined && typeof previous !== "string")
				throw new SessionRejected("Unsupported editor session record");
			const { sessionStoreTransition } =
				await import("opencut-editor-runtime-wasm");
			let next: z.infer<typeof transitionResult>;
			try {
				next = transitionResult.parse(
					sessionStoreTransition(
						previous ?? "",
						accountId,
						projectId,
						request,
						Date.now(),
					),
				);
			} catch (error) {
				throw new SessionRejected(
					error instanceof Error ? error.message : String(error),
				);
			}
			// Initial adoption reads the legacy history under the same lock as
			// the project. The client never combines independently fetched saves.
			const legacyHistory =
				next.project === null
					? await readFile(join(directory, "history.json"), "utf8")
							.then((value): unknown => JSON.parse(value))
							.catch((error: NodeJS.ErrnoException) => {
								if (error.code === "ENOENT") return null;
								throw error;
							})
					: null;
			assertLock();
			assertHostLock();
			const reading = z
				.object({ type: z.enum(["read", "inspect"]) })
				.passthrough()
				.safeParse(request).success;
			if (next.record !== previous && !(reading && previous === undefined)) {
				const value = {
					...(next.project ?? project),
					[EDITOR_SESSION_FIELD]: next.record,
				};
				await replaceProjectRecord({
					path,
					value,
					assertLock: () => {
						assertLock();
						assertHostLock();
					},
				});
			}
			const legacyProject = { ...project };
			delete legacyProject[EDITOR_SESSION_FIELD];
			return {
				...z.record(z.string(), z.unknown()).parse(next.result),
				legacyProject: next.project === null ? legacyProject : null,
				legacyHistory,
			};
		},
	});
}
