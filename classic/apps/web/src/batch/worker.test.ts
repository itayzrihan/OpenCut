import { expect, mock, test } from "bun:test";
import type { BatchRun, BatchState } from "./types";
const options = {
	zoom: true,
	transitions: true,
	wordAnimation: true,
	music: true,
};
let active = "",
	playing = 0,
	maxPlaying = 0;
let failEditing = false;
let saveFailures = 0;
let dirty = false;
const lifecycle: string[] = [];
const created: string[] = [],
	edits: string[] = [],
	saved: string[] = [];
let run: BatchRun = {
	id: "test",
	options,
	updatedAt: 0,
	jobs: ["bad", "good", "cancelled"].map((id) => ({
		projectId: id,
		name: id,
		fileName: `${id}.mp4`,
		status: "queued",
		message: "",
		cancelRequested: id === "cancelled",
		created: false,
		completedStages: 0,
	})),
};
mock.module("@/core", () => ({
	EditorCore: {
		getInstance: () => ({
			project: {
				createNewProject: async ({ id }: { id: string }) => {
					active = id;
					created.push(id);
					return id;
				},
				closeProject: () => {
					if (dirty)
						throw new Error(
							"Cannot close a project while it has unsaved changes",
						);
					active = "";
				},
				loadProject: async ({ id }: { id: string }) => {
					active = id;
					return true;
				},
				updateThumbnail: async () => {},
				prepareExit: async () => {
					if (saveFailures-- > 0) throw new Error("Editor storage unavailable");
					dirty = false;
					saved.push(active);
					lifecycle.push(`release:${active}`);
				},
			},
			media: {
				addMediaAsset: async ({ asset }: { asset: unknown }) => ({
					...(asset as object),
					id: active,
				}),
			},
			timeline: { insertElement: () => {} },
			save: { getIsDirty: () => dirty, flush: async () => {}, stop: () => {} },
			command: { flushHistory: async () => {} },
		}),
	},
}));
mock.module("@/media/processing", () => ({
	processMediaAssets: async ({ files }: { files: File[] }) =>
		files[0].name === "bad.mp4"
			? []
			: [{ name: files[0].name, type: "video", duration: 8 }],
	processLocalDriveMedia: async () => [],
}));
mock.module("@/services/local-drive/client", () => ({
	registerLocalMediaPaths: async () => [],
}));
mock.module("@/timeline/element-utils", () => ({
	buildElementFromMedia: () => ({}),
}));
mock.module("@/wasm", () => ({
	ZERO_MEDIA_TIME: 0,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds * 120000,
}));
mock.module("@/services/renderer/gpu-renderer", () => ({
	initializeGpuRenderer: async () => {},
}));
mock.module("opencut-wasm", () => ({
	batchEditIsLocked: ({ status }: { status: string }) =>
		["queued", "importing", "ready", "running"].includes(status),
}));
mock.module("./client", () => ({
	batchRequest: async (data: {
		projectId?: string;
		event?: string;
		created?: boolean;
		message?: string;
		completedStages?: number;
	}): Promise<BatchState> => {
		const job = run.jobs.find((j) => j.projectId === data.projectId);
		if (job) {
			if (data.event === "complete" || data.event === "fail")
				lifecycle.push(`terminal:${data.event}`);
			if (data.created) job.created = true;
			if (data.message) job.message = data.message;
			if (data.completedStages !== undefined)
				job.completedStages = data.completedStages;
			if (data.event)
				job.status = (
					{
						import: "importing",
						ready: "ready",
						run: "running",
						complete: "completed",
						cancel: "cancelled",
						fail: "failed",
					} as const
				)[data.event as "import"];
		}
		return { executionRunId: run.id, runs: [structuredClone(run)] };
	},
}));
mock.module("@/ai/full-auto-edit", () => ({
	runFullAutoEdit: async ({
		options: actual,
		onStep,
	}: {
		options: unknown;
		onStep: (p: unknown) => void;
	}) => {
		expect(actual).toEqual(options);
		if (failEditing) throw new Error("preflight: missing font");
		playing++;
		maxPlaying = Math.max(maxPlaying, playing);
		edits.push(active);
		onStep({ completedStages: 3, message: "Transcribing" });
		await Promise.resolve();
		playing--;
		return [];
	},
}));
const { executeBatch } = await import("./worker");
test("worker creates one project per video, isolates failed imports, respects cancellation and reuses full recipe options", async () => {
	const globals = globalThis as unknown as Record<string, unknown>;
	const previous = {
		window: globals.window,
		parent: globals.parent,
		location: globals.location,
	};
	globals.window = {
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globals.parent = { postMessage: () => {} };
	globals.location = { origin: "http://localhost" };
	try {
		await executeBatch({
			run,
			token: "test-lease",
			files: run.jobs.map((j) => new File(["video"], j.fileName)),
		});
		expect(created).toEqual(["bad", "good"]);
		expect(run.jobs.map((j) => j.status)).toEqual([
			"failed",
			"completed",
			"cancelled",
		]);
		expect(edits).toEqual(["good"]);
		expect(maxPlaying).toBe(1);
		expect(saved).toEqual(["bad", "good"]);
	} finally {
		Object.assign(globals, previous);
	}
});

test("existing-project worker never recreates or imports the project", async () => {
	const oldRun = run;
	run = {
		id: "existing",
		kind: "single",
		options,
		updatedAt: 0,
		jobs: [
			{
				projectId: "original",
				name: "Original",
				fileName: "Original",
				source: "existing",
				status: "ready",
				created: true,
				cancelRequested: false,
				completedStages: 0,
				message: "",
			},
		],
	};
	const globals = globalThis as unknown as Record<string, unknown>;
	const old = {
		window: globals.window,
		parent: globals.parent,
		location: globals.location,
	};
	globals.window = {
		addEventListener: () => {},
		removeEventListener: () => {},
	};
	globals.parent = { postMessage: () => {} };
	globals.location = { origin: "http://localhost" };
	const createdBefore = created.length;
	try {
		await executeBatch({ run, token: "existing-token", files: [] });
		expect(created.length).toBe(createdBefore);
		expect(edits.at(-1)).toBe("original");
		expect(saved.at(-1)).toBe("original");
		expect(run.jobs[0].status).toBe("completed");
		// One ambiguous final-save failure retries persistence without rerunning edits.
		const editsBeforeRetry = edits.length;
		saveFailures = 1;
		dirty = true;
		run.jobs[0].status = "ready";
		await executeBatch({ run, token: "existing-token", files: [] });
		expect(run.jobs[0].status).toBe("completed");
		expect(edits.length).toBe(editsBeforeRetry + 1);
		expect(dirty).toBe(false);
		failEditing = true;
		run.jobs[0].status = "ready";
		await executeBatch({ run, token: "existing-token", files: [] });
		expect(run.jobs[0].status).toBe("failed");
		expect(run.jobs[0].message).toContain("missing font");
		expect(lifecycle.slice(-2)).toEqual(["release:original", "terminal:fail"]);
	} finally {
		failEditing = false;
		run = oldRun;
		Object.assign(globals, old);
	}
});

test("failed final saves retain the dirty worker and original error until an authenticated retry saves it", async () => {
	const oldRun = run;
	run = {
		id: "save-recovery",
		options,
		updatedAt: 0,
		jobs: [
			{
				projectId: "recover",
				name: "Recover",
				fileName: "Recover",
				source: "existing",
				status: "ready",
				created: true,
				cancelRequested: false,
				completedStages: 3,
				message: "",
			},
		],
	};
	const globals = globalThis as unknown as Record<string, unknown>;
	const old = {
		window: globals.window,
		parent: globals.parent,
		location: globals.location,
	};
	const listeners = new Set<(event: unknown) => void>();
	const messages: Array<{ type: string; message?: string }> = [];
	let unblock!: () => void;
	const blocked = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	globals.window = {
		// eslint-disable-next-line opencut/prefer-object-params -- Native EventTarget signature.
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			if (type === "message") listeners.add(listener);
		},
		// eslint-disable-next-line opencut/prefer-object-params -- Native EventTarget signature.
		removeEventListener: (_type: string, listener: (event: unknown) => void) =>
			listeners.delete(listener),
	};
	globals.parent = {
		postMessage: (message: { type: string; message?: string }) => {
			messages.push(message);
			if (message.type === "opencut-batch-save-blocked") unblock();
		},
	};
	globals.location = { origin: "http://localhost" };
	failEditing = true;
	saveFailures = 2;
	dirty = true;
	try {
		const execution = executeBatch({ run, token: "recovery-token", files: [] });
		await blocked;
		expect(run.jobs[0].status).toBe("running");
		expect(run.jobs[0].message).toContain("missing font");
		expect(run.jobs[0].message).toContain("Editor storage unavailable");
		expect(run.jobs[0].message).not.toContain("Cannot close");
		expect(active).toBe("recover");
		expect(dirty).toBe(true);
		expect(messages.some((m) => m.type === "opencut-batch-finished")).toBe(
			false,
		);
		const retry = {
			origin: "http://localhost",
			source: globals.parent,
			data: { type: "opencut-batch-retry-save", id: run.id },
		};
		for (const listener of listeners)
			listener({ ...retry, origin: "http://untrusted" });
		expect(listeners.size).toBe(1);
		for (const listener of listeners) listener(retry);
		await execution;
		expect(dirty).toBe(false);
		expect(active).toBe("");
		expect(run.jobs[0].status).toBe("failed");
		expect(run.jobs[0].message).toContain("missing font");
		expect(messages.at(-1)?.type).toBe("opencut-batch-finished");
		expect(lifecycle.slice(-2)).toEqual(["release:recover", "terminal:fail"]);
	} finally {
		failEditing = false;
		saveFailures = 0;
		dirty = false;
		run = oldRun;
		Object.assign(globals, old);
	}
});
