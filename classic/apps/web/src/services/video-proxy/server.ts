import { createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { accountDataRoot } from "@/accounts/server";
import { getMediaFile } from "@/services/local-drive/server";
import { transcodePreview } from "./transcode";

// Account-scoped, reproducible cache; not editor state or an alternate registry.
const VERSION = "preview-h264-1280-v1";
type Status = "building" | "ready" | "unavailable" | "missing";
type Job = { controller: AbortController; status: Status; updated: number };
const host = globalThis as typeof globalThis & {
	__opencutProxyJobs?: Map<string, Job>;
	__opencutProxyPrepare?: Promise<void>;
};
const jobs = (host.__opencutProxyJobs ??= new Map<string, Job>());
const MAX_ACCOUNT_BYTES = 8 * 1024 ** 3;

export async function proxySource({
	projectId,
	mediaId,
}: {
	projectId: string;
	mediaId: string;
}) {
	const file = await getMediaFile(projectId, mediaId);
	if (!file || !file.record.mimeType?.startsWith("video/"))
		throw new Error("Video source unavailable");
	const fingerprint = (info: typeof file.stat) =>
		[
			VERSION,
			file.path,
			info.dev,
			info.ino,
			info.size,
			info.mtimeMs,
			info.ctimeMs,
		].join(":");
	const identity = fingerprint(file.stat);
	const key = createHash("sha256").update(identity).digest("hex");
	const directory = join(accountDataRoot(), "cache", "preview-proxies");
	return {
		file,
		key,
		directory,
		path: join(directory, `${key}.mp4`),
		marker: join(directory, `${key}.json`),
		unchanged: async () => fingerprint(await stat(file.path)) === identity,
	};
}

export async function proxyStatus(
	source: Awaited<ReturnType<typeof proxySource>>,
): Promise<Status> {
	try {
		const marker = JSON.parse(await readFile(source.marker, "utf8"));
		const info = await stat(source.path);
		if (marker.key === source.key && marker.size === info.size && info.size > 0)
			return "ready";
	} catch {
		/* Missing/incomplete caches always use the original. */
	}
	const job = jobs.get(source.path);
	if (job?.status === "ready") {
		jobs.delete(source.path);
		return "missing";
	}
	if (job?.status === "unavailable" && Date.now() - job.updated > 300_000) {
		jobs.delete(source.path);
		return "missing";
	}
	return job?.status ?? "missing";
}

async function prepareProxyUnlocked(
	source: Awaited<ReturnType<typeof proxySource>>,
): Promise<Status> {
	const status = await proxyStatus(source);
	if (status !== "missing") return status;
	// One background encode across accounts in this host, no unbounded queue.
	if ([...jobs.values()].some((job) => job.status === "building"))
		return "missing";
	for (const [key, job] of jobs)
		if (job.status !== "building" && Date.now() - job.updated > 300_000)
			jobs.delete(key);
	if (jobs.size >= 64) return "unavailable";
	await mkdir(source.directory, { recursive: true, mode: 0o700 });
	const entries = await readdir(source.directory);
	let bytes = 0;
	for (const name of entries)
		bytes += (await stat(join(source.directory, name))).size;
	if (bytes > MAX_ACCOUNT_BYTES - 2 * 1024 ** 3) return "unavailable";
	// Cross-process exclusivity; a crash leaves a recoverable lock, never a ready file.
	const lock = `${source.path}.lock`;
	try {
		await writeFile(lock, JSON.stringify({ pid: process.pid }), {
			flag: "wx",
			mode: 0o600,
		});
	} catch {
		try {
			const owner = JSON.parse(await readFile(lock, "utf8"));
			try {
				process.kill(owner.pid, 0);
				return "building";
			} catch (error) {
				if (
					!(error instanceof Error && "code" in error && error.code === "ESRCH")
				)
					return "building";
			}
			await rm(lock);
		} catch {
			return "missing";
		}
		return "missing";
	}
	const controller = new AbortController();
	const job: Job = { controller, status: "building", updated: Date.now() };
	jobs.set(source.path, job);
	const timeout = setTimeout(() => controller.abort(), 60 * 60 * 1000);
	void (async () => {
		try {
			const details = await transcodePreview({
				source: source.file.path,
				destination: source.path,
				signal: controller.signal,
			});
			if (!(await source.unchanged()))
				throw new Error("Source changed during proxy generation");
			const info = await stat(source.path);
			await writeFile(
				`${source.marker}.tmp`,
				JSON.stringify({ key: source.key, size: info.size, ...details }),
				{ mode: 0o600 },
			);
			await rename(`${source.marker}.tmp`, source.marker);
			job.status = "ready";
		} catch {
			job.status = "unavailable";
			await rm(source.path, { force: true });
		} finally {
			clearTimeout(timeout);
			job.updated = Date.now();
			await rm(lock, { force: true }).catch(() => {});
		}
	})();
	return "building";
}

export function cancelProxy(source: Awaited<ReturnType<typeof proxySource>>) {
	jobs.get(source.path)?.controller.abort();
}

export function prepareProxy(
	source: Awaited<ReturnType<typeof proxySource>>,
): Promise<Status> {
	const pending = (host.__opencutProxyPrepare ?? Promise.resolve()).then(() =>
		prepareProxyUnlocked(source),
	);
	host.__opencutProxyPrepare = pending.then(
		() => {},
		() => {},
	);
	return pending;
}
