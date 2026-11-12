/** Hosted projects keep their media in this browser. Store frozen inputs and
 * outputs beside the same Rust queue state that the desktop host uses. */
import { z } from "zod";
import { loadCanonicalRuntime } from "@/core/load-canonical-runtime";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { storageService } from "@/services/storage/service";
import type { CanonicalEditorRuntime } from "opencut-editor-runtime-wasm";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import type { RenderJob } from "./types";
import { edit, nextRender, releaseQueue, view, type State } from "./runtime";

type Files = {
	id: string;
	media: Record<string, Blob>;
	fonts: Record<string, Blob>;
};
const account = () => {
	const id = window.__opencutAccountId;
	if (!id || !window.__opencutHostedLegitate)
		throw Error("Open a hosted account before using its export queue");
	return id;
};
const store = <T>(name: string, accountId: string) =>
	new IndexedDBAdapter<T>({
		dbName: `render-queue-${name}`,
		storeName: name,
		accountId,
	});

let instance:
	| Promise<{ runtime: CanonicalEditorRuntime; empty: Uint8Array }>
	| undefined;
async function transaction<T>(
	run: (
		runtime: CanonicalEditorRuntime,
		state: State,
		accountId: string,
	) => T | Promise<T>,
) {
	const id = account();
	if (!navigator.locks)
		throw Error("This browser does not support a shared render queue");
	return navigator.locks.request("opencut-render-state", async () => {
		const records = store<{ id: string; bytes: Uint8Array }>("state", id);
		const previous = await records.get("queue");
		const { runtime, empty } = await (instance ??= loadCanonicalRuntime()
			.then((runtime) => ({
				runtime,
				empty: runtime.serialize(),
			}))
			.catch((error) => {
				instance = undefined;
				throw error;
			}));
		runtime.restore(previous?.bytes ?? empty);
		const state = runtime.snapshot() as State;
		const result = await run(runtime, state, id);
		if (account() !== id) throw Error("The render account changed");
		if ((runtime.snapshot() as State).revision !== state.revision)
			await records.set({
				key: "queue",
				value: { id: "queue", bytes: runtime.serialize() },
			});
		return result;
	});
}

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const command = z.discriminatedUnion("action", [
	z.object({ action: z.literal("start") }),
	z.object({
		action: z.literal("enqueue"),
		id: z.string().uuid(),
		projectId: id,
		sceneId: id,
		sourceRevision: z.number().int().nonnegative(),
		snapshot: z.custom<CanonicalClassicSnapshot>(),
		options: z.unknown(),
		delivery: z.enum(["queue", "direct"]).optional(),
		destinationName: z.string().optional(),
	}),
	z.object({
		action: z.enum(["cancel", "retry", "configure"]),
		id: z.string().uuid(),
		projectId: id,
		expectedRevision: z.number().int().nonnegative(),
		options: z.unknown().optional(),
	}),
	z.object({
		action: z.literal("claim"),
		attempt: z.string().uuid(),
		jobId: z.string().uuid().optional(),
	}),
	z.object({
		action: z.literal("report"),
		id: z.string().uuid(),
		projectId: id,
		attempt: z.string().uuid(),
		progress: z.number(),
		message: z.string(),
		status: z.enum(["rendering", "failed", "cancelled", "completed"]),
	}),
]);

async function freezeSources(
	job: Pick<RenderJob, "id" | "snapshot" | "projectId">,
) {
	const files: Files = {
		id: job.id,
		media: Object.create(null),
		fonts: Object.create(null),
	};
	for (const binding of job.snapshot.mediaAssets) {
		if (binding.unifiedAngles) continue;
		const asset = await storageService.loadMediaAsset({
			projectId: job.projectId,
			id: binding.id,
		});
		if (asset?.missing || (!asset?.file && !asset?.url))
			throw Error(`Reconnect this source before queueing: ${binding.name}`);
		if (
			(asset.bindingRevision ?? 0) !== (binding.bindingRevision ?? 0) ||
			(asset.size !== undefined && binding.size !== asset.size) ||
			(asset.lastModified !== undefined &&
				binding.lastModified !== asset.lastModified)
		)
			throw Error(`Media changed before it could be queued: ${binding.name}`);
		if (asset.file) files.media[binding.id] = asset.file;
		else {
			const response = await fetch(asset.url!);
			if (!response.ok) throw Error(`Could not freeze source: ${binding.name}`);
			files.media[binding.id] = await response.blob();
		}
		if (binding.size && files.media[binding.id].size !== binding.size)
			throw Error(`Media changed before it could be queued: ${binding.name}`);
	}
	for (const font of job.snapshot.document.customFonts ?? []) {
		const asset = await storageService.loadProjectFont({
			projectId: job.projectId,
			id: font.id,
		});
		if (asset?.file) files.fonts[font.id] = asset.file;
		if (asset?.url?.startsWith("blob:")) URL.revokeObjectURL(asset.url);
	}
	return files;
}

export async function browserRenderRequest(body?: unknown): Promise<unknown> {
	if (!body) return transaction((_runtime, state) => view(state));
	const input = command.parse(body);
	const capturedAccount = account();
	const files =
		input.action === "enqueue"
			? (await transaction((_runtime, state) =>
					state.renderQueue.some((job) => job.id === input.id),
				))
				? undefined
				: await freezeSources(input)
			: undefined;
	return transaction(async (runtime, state, accountId) => {
		if (accountId !== capturedAccount)
			throw Error("The render account changed");
		if (input.action === "start") return releaseQueue(runtime, state);
		if (input.action === "enqueue") {
			const existing = state.renderQueue.find((job) => job.id === input.id);
			if (existing) {
				if (
					existing.projectId !== input.projectId ||
					existing.delivery !== (input.delivery ?? "queue") ||
					(input.delivery === "direct" &&
						existing.destinationName !== input.destinationName)
				)
					throw Error("Export identity conflict");
				return view(state);
			}
			const { action: _, id: jobId, projectId, ...payload } = input;
			const job = edit(runtime, state, jobId, projectId, {
				type: "enqueue",
				...payload,
			});
			if (!files) throw Error("The export sources are unavailable");
			await store<Files>("sources", accountId).set({
				key: job.id,
				value: files,
			});
			return view(runtime.snapshot() as State);
		}
		if (input.action === "claim") {
			const next = nextRender({ runtime, state, jobId: input.jobId });
			return next
				? edit(runtime, next.state, next.job.id, next.job.projectId, {
						type: "claim",
						attempt: input.attempt,
					})
				: null;
		}
		if (input.action === "report") {
			const { id: jobId, projectId, action: _, ...report } = input;
			const current = state.renderQueue.find((job) => job.id === jobId);
			if (report.status === "completed" && current?.delivery !== "direct")
				throw Error("Save the export before completing it");
			const job = edit(runtime, state, jobId, projectId, {
				type: "report",
				...report,
			});
			return { status: job.status, cancelRequested: job.cancelRequested };
		}
		if (input.expectedRevision !== state.revision)
			throw Error("Queue changed; refresh and try again");
		edit(runtime, state, input.id, input.projectId, {
			type: input.action,
			...(input.options ? { options: input.options } : {}),
		});
		return view(runtime.snapshot() as State);
	});
}

export async function readBrowserRenderSources(jobId: string) {
	const files = await store<Files>("sources", account()).get(jobId);
	if (!files)
		throw Error(
			"The frozen files for this export are unavailable in this browser",
		);
	return files;
}

export async function publishBrowserRender({
	job,
	file,
}: {
	job: RenderJob;
	file: Blob;
}) {
	return transaction(async (runtime, state, accountId) => {
		const current = state.renderQueue.find((item) => item.id === job.id);
		if (
			!current ||
			current.status !== "rendering" ||
			current.attempt !== job.attempt ||
			current.cancelRequested ||
			!file.size
		)
			throw Error("Render attempt no longer owns the output");
		await store<{ id: string; file: Blob }>("outputs", accountId).set({
			key: job.id,
			value: { id: job.id, file },
		});
		return edit(runtime, state, job.id, job.projectId, {
			type: "report",
			attempt: job.attempt,
			progress: 1,
			message: "Complete",
			status: "completed",
		}).status;
	});
}

export async function downloadBrowserRender(
	job: Pick<RenderJob, "id" | "options"> & { projectName: string },
) {
	const output = await store<{ id: string; file: Blob }>(
		"outputs",
		account(),
	).get(job.id);
	if (!output) throw Error("This export is no longer stored in this browser");
	const url = URL.createObjectURL(output.file);
	const link = document.createElement("a");
	link.href = url;
	link.download = `${job.projectName}.${job.options.format}`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
