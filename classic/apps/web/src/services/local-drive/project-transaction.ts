import { mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { accountDataRoot } from "@/accounts/server";

/** One process-safe file transaction for canonical and legacy project writes.
 * The caller performs IO; Rust owns session, generation and revision policy. */
export async function withProjectStorageLock<T>({
	projectId,
	write,
}: {
	projectId: string;
	write: (context: {
		directory: string;
		path: string;
		assertLock: () => void;
	}) => Promise<T>;
}): Promise<T> {
	if (!/^[A-Za-z0-9_-]{1,160}$/.test(projectId))
		throw new Error("Invalid project id");
	const directory = join(accountDataRoot(), "projects", projectId);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let compromised = false;
	const release = await lockfile.lock(directory, {
		realpath: false,
		stale: 60_000,
		update: 10_000,
		retries: { retries: 40, minTimeout: 50, maxTimeout: 500 },
		onCompromised: () => {
			compromised = true;
		},
	});
	const assertLock = () => {
		if (compromised)
			throw new Error("Project storage lock was lost; reconcile the last save");
	};
	try {
		return await write({
			directory,
			path: join(directory, "project.json"),
			assertLock,
		});
	} finally {
		await release();
	}
}

export const EDITOR_SESSION_FIELD = "__opencutEditorSession";

/** Caller holds the project lock. Recheck its outer locks before publication. */
export async function replaceProjectRecord({
	path,
	value,
	assertLock,
}: {
	path: string;
	value: unknown;
	assertLock: () => void;
}) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(JSON.stringify(value));
			await file.sync();
		} finally {
			await file.close();
		}
		assertLock();
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
