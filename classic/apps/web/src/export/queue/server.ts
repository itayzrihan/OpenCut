/** Host IO only. Every queue transition is executed by OpenCutRuntime. */
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	unlink,
	stat,
	link,
	copyFile,
	open,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import {
	getMediaFile,
	getFontFile,
	getSharedFile,
	getProject,
} from "@/services/local-drive/server";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { RenderJob, RenderQueueView } from "./types";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { ExportOptions } from "@/export";
type State = { revision: number; renderQueue: RenderJob[] };
type Source = {
	id: string;
	path: string;
	size: number;
	mtimeMs: number;
	mimeType: string;
	kind: "media" | "font";
};
const root = () => join(accountDataRoot(), "render-queue");
const valid = (s: string) => {
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(s)) throw Error("Invalid render identity");
	return s;
};
export const renderJobDirectory = (id: string) => join(root(), valid(id));
/** Output bytes may live on a host-configured export disk. Frozen source
 * manifests and canonical queue state remain in the account's data root. */
export async function renderOutputDirectory(id: string) {
	const external = process.env.OPENCUT_RENDER_OUTPUTS_DIR;
	if (!external) return renderJobDirectory(id);
	if (!external.startsWith("/") || !(await stat(external)).isDirectory())
		throw Error("The render output disk is unavailable");
	const directory = join(external, requireAccountId(), valid(id));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return directory;
}
function requireAccountId() {
	return requireAccount().id;
}
export async function renderOutputPath(id: string, format: "mp4" | "webm") {
	if (process.env.OPENCUT_RENDER_OUTPUTS_DIR) {
		const external = join(
			process.env.OPENCUT_RENDER_OUTPUTS_DIR,
			requireAccountId(),
			valid(id),
			`output.${format}`,
		);
		try {
			await stat(external);
			return external;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return join(renderJobDirectory(id), `output.${format}`);
}
// Registry construction is expensive. Reuse one canonical runtime per host
// module, restoring the locked account bytes before every transaction. A local
// gate prevents cross-account interleaving while the filesystem lock fences
// other server processes. No account document is cached outside the runtime.
let hostRuntime:
	| Promise<{ runtime: CanonicalEditorRuntime; empty: Uint8Array }>
	| undefined;
let transactionTail = Promise.resolve();
function transaction<T>(
	run: (r: CanonicalEditorRuntime, s: State) => Promise<T> | T,
): Promise<T> {
	const next = transactionTail.then(() => lockedTransaction(run));
	transactionTail = next.then(
		() => {},
		() => {},
	);
	return next;
}
async function lockedTransaction<T>(
	run: (r: CanonicalEditorRuntime, s: State) => Promise<T> | T,
): Promise<T> {
	const path = root();
	await mkdir(path, { recursive: true, mode: 0o700 });
	let lost = false;
	const release = await lockfile.lock(path, {
		realpath: false,
		stale: 60000,
		update: 10000,
		retries: { retries: 200, minTimeout: 25, maxTimeout: 150 },
		onCompromised: () => {
			lost = true;
		},
	});
	try {
		hostRuntime ??= import("opencut-editor-runtime-wasm")
			.then(({ CanonicalEditorRuntime }) => {
				const runtime = new CanonicalEditorRuntime();
				return { runtime, empty: runtime.serialize() };
			})
			.catch((error) => {
				hostRuntime = undefined;
				throw error;
			});
		const { runtime: r, empty } = await hostRuntime;
		const bytes = await readFile(join(path, "runtime.json")).catch((e) => {
			if (e.code === "ENOENT") return null;
			throw e;
		});
		r.restore(bytes ?? empty);
		const before = r.serialize();
		const result = await run(r, r.snapshot() as State);
		if (lost) throw Error("Render queue storage lock was lost");
		const after = r.serialize();
		if (!bytes || !Buffer.from(before).equals(Buffer.from(after))) {
			const temp = join(path, `runtime-${randomUUID()}.tmp`);
			try {
				const file = await open(temp, "wx", 0o600);
				try {
					await file.writeFile(after);
					await file.sync();
				} finally {
					await file.close();
				}
				if (lost) throw Error("Render queue lock was lost");
				await rename(temp, join(path, "runtime.json"));
			} finally {
				await unlink(temp).catch(() => {});
			}
		}
		return result;
	} finally {
		await release();
	}
}
function edit(
	r: CanonicalEditorRuntime,
	s: State,
	id: string,
	projectId: string,
	change: Record<string, unknown>,
	requestId?: string,
): RenderJob {
	const result = r.invokeSync(
		"render.queue.edit",
		{ projectId, expectedRevision: s.revision, id, nowMs: Date.now(), change },
		{ metadata: requestId ? { "opencut/idempotencyKey": requestId } : {} },
	) as { result: { data: { job: RenderJob } } };
	return result.result.data.job;
}
function view(s: State): RenderQueueView {
	return {
		revision: s.revision,
		jobs: s.renderQueue.map(({ snapshot, attempt: _attempt, ...j }) => ({
			...j,
			projectName: snapshot.document.metadata.name,
			sceneName:
				snapshot.document.scenes.find((s) => s.id === j.sceneId)?.name ??
				"Scene",
		})),
	};
}
export async function readRenderQueue() {
	return transaction((_r, s) => view(s));
}
async function captureSources(
	id: string,
	projectId: string,
	snapshot: CanonicalClassicSnapshot,
) {
	if (!(await getProject(projectId)))
		throw Error("Source project is unavailable");
	const directory = renderJobDirectory(id);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const sources: Source[] = [];
	for (const asset of snapshot.mediaAssets) {
		if (asset.unifiedAngles) continue;
		const file = await getMediaFile(projectId, asset.id);
		if (!file)
			throw Error(`Link missing source before queueing: ${asset.name}`);
		if (asset.sourcePath && asset.sourcePath !== file.path)
			throw Error(`Media binding changed: ${asset.name}`);
		let path = file.path;
		if (file.record.storageKind === "copied") {
			path = join(directory, `media-${valid(asset.id)}`);
			await link(file.path, path).catch((e) => {
				if (e.code !== "EEXIST") throw e;
			});
		}
		sources.push({
			id: asset.id,
			path,
			size: file.stat.size,
			mtimeMs: file.stat.mtimeMs,
			mimeType: file.record.mimeType,
			kind: "media",
		});
	}
	for (const font of snapshot.document.customFonts ?? []) {
		const file =
			(await getFontFile(projectId, font.id)) ??
			(await getSharedFile("fonts", font.id));
		// Bundled/shared fonts are hydrated by the normal font loader.
		if (!file) continue;
		const path = join(directory, `font-${valid(font.id)}`);
		await copyFile(file.path, path);
		const info = await stat(path);
		sources.push({
			id: font.id,
			path,
			size: info.size,
			mtimeMs: info.mtimeMs,
			mimeType: font.mimeType,
			kind: "font",
		});
	}
	await writeFile(join(directory, "sources.json"), JSON.stringify(sources), {
		mode: 0o600,
	});
}
export async function enqueueRender(input: {
	id: string;
	projectId: string;
	sceneId: string;
	sourceRevision: number;
	snapshot: CanonicalClassicSnapshot;
	options: ExportOptions;
	delivery?: "queue" | "direct";
	destinationName?: string;
}) {
	valid(input.id);
	valid(input.projectId);
	return transaction(async (r, s) => {
		const existing = s.renderQueue.find((j) => j.id === input.id);
		if (existing) {
			if (existing.projectId !== input.projectId)
				throw Error("Render identity conflict");
			return view(s);
		}
		// Validate before performing filesystem work. Dry run makes no queue changes.
		const change = {
			type: "enqueue",
			snapshot: input.snapshot,
			sceneId: input.sceneId,
			sourceRevision: input.sourceRevision,
			options: input.options,
			delivery: input.delivery ?? "queue",
			destinationName: input.destinationName ?? null,
		};
		r.invokeSync(
			"render.queue.edit",
			{
				id: input.id,
				projectId: input.projectId,
				expectedRevision: s.revision,
				nowMs: Date.now(),
				change,
			},
			{ dryRun: true },
		);
		await captureSources(input.id, input.projectId, input.snapshot);
		edit(r, s, input.id, input.projectId, change, input.id);
		return view(r.snapshot() as State);
	});
}
export async function changeRender(input: {
	id: string;
	projectId: string;
	expectedRevision: number;
	type: "cancel" | "retry" | "configure";
	options?: ExportOptions;
}) {
	return transaction((r, s) => {
		if (s.revision !== input.expectedRevision)
			throw Error("Queue changed; refresh and try again");
		edit(r, s, input.id, input.projectId, {
			type: input.type,
			...(input.options ? { options: input.options } : {}),
		});
		return view(r.snapshot() as State);
	});
}
export async function claimRender(
	attempt: string,
	jobId?: string,
): Promise<RenderJob | null> {
	valid(attempt);
	return transaction(async (r, s) => {
		const active = s.renderQueue.find((j) => j.status === "rendering");
		if (active && Date.now() - active.updatedAtMs <= 120000) return null;
		if (active) {
			edit(r, s, active.id, active.projectId, {
				type: "report",
				attempt: active.attempt,
				progress: active.progress,
				message: "Renderer disconnected; retry uses the original snapshot",
				status: active.cancelRequested ? "cancelled" : "failed",
			});
			s = r.snapshot() as State;
		}
		// If the renderer disappeared, claim the same job after an explicit failed
		// boundary, never silently retry a potentially completed side effect.
		const next = jobId
			? s.renderQueue.find(
					(j) =>
						j.id === valid(jobId) &&
						j.delivery === "direct" &&
						j.status === "queued",
				)
			: s.renderQueue.find(
					(j) => j.status === "queued" && j.delivery !== "direct",
				);
		if (!next) return null;
		if (next.delivery !== "direct") await renderOutputDirectory(next.id);
		return edit(r, s, next.id, next.projectId, { type: "claim", attempt });
	});
}
export async function reportRender(input: {
	id: string;
	projectId: string;
	attempt: string;
	progress: number;
	message: string;
	status: RenderJob["status"];
}) {
	return transaction((r, s) => {
		const old = s.renderQueue.find((j) => j.id === input.id);
		// A completion reply can be lost after committing. Exact completed attempts
		// are reconciled by the worker's final output upload rather than rerendering.
		if (old?.status === "completed" && input.status === "completed")
			return { cancelRequested: false, status: old.status };
		const job = edit(r, s, input.id, input.projectId, {
			type: "report",
			attempt: input.attempt,
			progress: input.progress,
			message: input.message,
			status: input.status,
		});
		return { cancelRequested: job.cancelRequested, status: job.status };
	});
}
export async function readRenderJob(id: string) {
	return transaction((_r, s) => {
		const j = s.renderQueue.find((j) => j.id === valid(id));
		if (!j) throw Error("Unknown render job");
		return j;
	});
}
export async function renderSource(
	id: string,
	sourceId: string,
	kind: "media" | "font",
) {
	const job = await readRenderJob(id);
	if (!job) throw Error("Unknown render");
	const sources: Source[] = JSON.parse(
		await readFile(join(renderJobDirectory(id), "sources.json"), "utf8"),
	);
	const source = sources.find((s) => s.id === sourceId && s.kind === kind);
	if (!source) throw Error("Unknown frozen source");
	const info = await stat(source.path);
	if (
		!info.isFile() ||
		info.size !== source.size ||
		info.mtimeMs !== source.mtimeMs
	)
		throw Error(
			"A queued source file changed. Restore the original media before retrying.",
		);
	return source;
}
