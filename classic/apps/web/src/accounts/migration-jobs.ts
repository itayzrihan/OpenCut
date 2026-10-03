import { importLegacyAccount } from "./migration";
import {
	markAccountImport,
	requireAccount,
	accountsRoot,
	accountDataRoot,
	importLocked,
	accountScope,
} from "./server";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
type Job = {
	status: "running" | "complete" | "failed" | "cancelled";
	files: number;
	total: number;
	error?: string;
	result?: { files: number; projects: number };
};
const host = globalThis as typeof globalThis & {
	__opencutImports?: Map<string, { state: Job; controller: AbortController }>;
};
const jobs = (host.__opencutImports ??= new Map());
function jobPath() {
	return join(accountsRoot(), "import-jobs", `${requireAccount().id}.json`);
}
async function persist(state: Job) {
	await mkdir(join(accountsRoot(), "import-jobs"), { recursive: true });
	const temporary = `${jobPath()}.${randomUUID()}.tmp`;
	await writeFile(temporary, JSON.stringify(state));
	await rename(temporary, jobPath());
}
export async function migrationJob() {
	const live = jobs.get(requireAccount().id)?.state;
	if (live) return live;
	try {
		const receipt = JSON.parse(
			await readFile(join(accountDataRoot(), "migration-receipt.json"), "utf8"),
		);
		if (receipt.accountId !== requireAccount().id)
			throw new Error("Import receipt account mismatch");
		return {
			status: "complete",
			files: receipt.verified.length,
			total: receipt.verified.length,
		} satisfies Job;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	try {
		const saved = JSON.parse(await readFile(jobPath(), "utf8")) as Job;
		if (saved.status === "running" && (await importLocked(requireAccount().id)))
			return saved;
		return saved.status === "running"
			? ({
					...saved,
					status: "failed",
					error:
						"The import host stopped before activation. Originals and partial staging are preserved. Retry to start a fresh verified copy.",
				} satisfies Job)
			: saved;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export function cancelMigration() {
	jobs.get(requireAccount().id)?.controller.abort();
}
export async function startMigration() {
	const account = requireAccount(),
		id = account.id;
	if (jobs.get(id)?.state.status === "running")
		throw new Error("Import is already running");
	await markAccountImport(id, true);
	const state: Job = { status: "running", files: 0, total: 0 },
		controller = new AbortController();
	try {
		await persist(state);
	} catch (error) {
		await markAccountImport(id, false);
		throw error;
	}
	jobs.set(id, { state, controller });
	void (async () => {
		let status: Job["status"] = "complete";
		try {
			state.result = await importLegacyAccount((files, total) => {
				state.files = files;
				state.total = total;
			}, controller.signal);
		} catch (error) {
			status = controller.signal.aborted ? "cancelled" : "failed";
			state.error = error instanceof Error ? error.message : String(error);
		}
		try {
			await markAccountImport(id, false);
			state.status = status;
			await accountScope.run(account, () => persist(state));
		} catch (error) {
			state.status = "failed";
			state.error = `Import status could not be saved: ${String(error)}`;
		}
	})();
	return state;
}
