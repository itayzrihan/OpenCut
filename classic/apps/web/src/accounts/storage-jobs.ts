import {
	accountScope,
	accountsRoot,
	markAccountImport,
	importLocked,
	requireAccount,
} from "./server";
import {
	publishAccountSnapshot,
	restoreAccountSnapshot,
	type StoragePolicy,
} from "./storage-host";
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
type Job = {
	action: "publish" | "restore";
	status: "running" | "complete" | "failed" | "cancelled";
	files: number;
	total: number;
	error?: string;
};
const host = globalThis as typeof globalThis & {
	__opencutStorageJobs?: Map<
		string,
		{ state: Job; controller: AbortController }
	>;
};
const jobs = (host.__opencutStorageJobs ??= new Map());
function path() {
	return join(accountsRoot(), "storage-jobs", `${requireAccount().id}.json`);
}
async function persist(state: Job) {
	await mkdir(join(accountsRoot(), "storage-jobs"), { recursive: true });
	const temporary = `${path()}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(state));
	await rename(temporary, path());
}
export async function storageJob() {
	const live = jobs.get(requireAccount().id)?.state;
	if (live) return live;
	try {
		const state: Job = JSON.parse(await readFile(path(), "utf8"));
		return state.status === "running" &&
			!(await importLocked(requireAccount().id))
			? {
					...state,
					status: "failed",
					error:
						"The host stopped during sync. Partial files and previous workspaces were retained. Check saved snapshots and the restore journal before retrying.",
				}
			: state;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export function cancelStorageJob() {
	jobs.get(requireAccount().id)?.controller.abort();
}
export async function startStorageJob({
	action,
	policy,
	snapshotId,
	preserveExisting = false,
	metadataOnly = false,
}: {
	action: "publish" | "restore";
	policy: StoragePolicy;
	snapshotId?: string;
	preserveExisting?: boolean;
	metadataOnly?: boolean;
}) {
	const account = requireAccount(),
		state: Job = { action, status: "running", files: 0, total: 0 },
		controller = new AbortController();
	await markAccountImport({
		id: account.id,
		active: true,
		mode: action === "publish" ? "snapshot" : "exclusive",
	});
	try {
		await persist(state);
	} catch (error) {
		await markAccountImport({ id: account.id, active: false });
		throw error;
	}
	jobs.set(account.id, { state, controller });
	// Storage snapshot callbacks report completed and total file counts positionally.
	// eslint-disable-next-line opencut/prefer-object-params
	const progress = (files: number, total: number) => {
		state.files = files;
		state.total = total;
	};
	void (async () => {
		let status: Job["status"] = "complete";
		try {
			await (action === "publish"
				? publishAccountSnapshot({
						policy,
						progress,
						signal: controller.signal,
					})
				: restoreAccountSnapshot({
						snapshotId: snapshotId!,
						policy: policy,
						progress: progress,
						signal: controller.signal,
						preserveExisting: preserveExisting,
						metadataOnly: metadataOnly,
					}));
		} catch (error) {
			status = controller.signal.aborted ? "cancelled" : "failed";
			state.error = error instanceof Error ? error.message : String(error);
		}
		try {
			await markAccountImport({ id: account.id, active: false });
			state.status = status;
			await accountScope.run(account, () => persist(state));
		} catch (error) {
			state.status = "failed";
			state.error = `Could not finalize sync status: ${String(error)}`;
		}
	})();
	return state;
}
