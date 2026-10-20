import { beforeEach, expect, mock, test } from "bun:test";
const saves: any[] = [];
const pending: any[] = [];
mock.module("@/services/storage/service", () => ({
	storageService: {
		saveMediaAsset: async (input: any) => {
			saves.push(structuredClone(input));
		},
		isQuotaExceededError: () => false,
	},
}));
mock.module("@/services/video-cache/service", () => ({
	videoCache: { clearAll() {} },
}));
mock.module("@/services/waveform-cache/service", () => ({
	waveformCache: { clearAll() {} },
}));
mock.module("@/media/waveform-summary", () => ({
	buildWaveformSourceKey: () => "",
}));
mock.module("@/services/local-drive/client", () => ({
	localDriveRequest: async () => ({}),
}));
mock.module("sonner", () => ({
	toast: { success() {}, error() {}, warning() {} },
}));
mock.module("opencut-wasm", () => ({
	unifiedCameraSourcesCurrent: () => false,
	podcastCameraClock: () => ({}),
	unifiedCameraRange: () => ({}),
	podcastMulticamDefaults: () => ({}),
}));
mock.module("@/podcast-sync/engine", () => ({
	resolvePodcastChannelSources: ({ channels }: any) => channels,
	runPodcastAlignment: (input: any) =>
		new Promise((resolve, reject) => pending.push({ input, resolve, reject })),
}));
const { MediaManager } = await import("@/core/managers/media-manager");
const cameras = [
	{ id: "cam-a", name: "A", type: "video", duration: 120, hasAudio: true },
	{ id: "cam-b", name: "B", type: "video", duration: 100, hasAudio: true },
];
const virtual = {
	name: "Interview",
	type: "video",
	duration: 120,
	unifiedAngles: {
		version: 1,
		angleAssetIds: ["cam-a", "cam-b"],
		defaultAngleAssetId: "cam-a",
		audioAssetId: "cam-a",
	},
};
function fixture() {
	let projectId = "project-a";
	const updates: any[] = [];
	const commits: any[] = [];
	let manager: any;
	const editor: any = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: projectId } }),
			getSessionReadOnlyReason: () => null,
		},
		command: {
			synchronizeMedia() {},
			flushHistory: async () => {},
			prepareClassicMediaImport:
				({ assets }: any) =>
				() =>
					manager.setAssets({ assets: [...manager.getAssets(), ...assets] }),
			updateUnifiedSyncTask: (input: any) => {
				updates.push(input);
				manager.setAssets({
					assets: manager.getAssets().map((a: any) =>
						a.id !== input.mediaId
							? a
							: {
									...a,
									unifiedAngles: {
										...a.unifiedAngles,
										syncTask:
											input.action === "start"
												? {
														id: input.taskId,
														status: "running",
														progress: 0,
														stage: "Preparing",
													}
												: {
														...a.unifiedAngles.syncTask,
														status:
															input.action === "fail"
																? "failed"
																: input.action === "cancel"
																	? "cancelled"
																	: "running",
														progress:
															input.progress ??
															a.unifiedAngles.syncTask.progress,
														error: input.error,
													},
									},
								},
					),
				});
			},
			syncUnifiedAngles: (inputs: any) => {
				commits.push(inputs);
				manager.setAssets({
					assets: manager.getAssets().map((a: any) =>
						a.id !== inputs[0].mediaId
							? a
							: {
									...a,
									unifiedAngles: {
										...a.unifiedAngles,
										syncTask: undefined,
										sync: { method: "audio", sources: inputs[0].sources },
									},
								},
					),
				});
			},
		},
	};
	manager = new MediaManager(editor);
	editor.media = manager;
	manager.setAssets({ assets: structuredClone(cameras) });
	return {
		manager,
		updates,
		commits,
		switchProject: (id: string) => {
			projectId = id;
		},
	};
}
async function worker() {
	for (let i = 0; i < 30 && !pending.length; i++)
		await new Promise((r) => setTimeout(r, 0));
	expect(pending.length).toBeGreaterThan(0);
	return pending.shift();
}
function result(mediaId: string) {
	return {
		unifiedSync: [
			{
				mediaId,
				sources: cameras.map((c) => ({
					id: c.id,
					duration: c.duration,
					start: 0,
					bindingRevision: 0,
				})),
			},
		],
		precisionWarnings: [],
	};
}
beforeEach(() => {
	saves.length = 0;
	pending.length = 0;
});
test("saving unified media automatically launches one background worker; duplicate requests join it and save canonical offsets", async () => {
	const f = fixture();
	const asset = await f.manager.addMediaAsset({
		projectId: "project-a",
		asset: virtual,
	});
	expect(asset).toBeTruthy();
	const a = f.manager.syncUnifiedAngles({
		projectId: "project-a",
		mediaId: asset.id,
	});
	expect(
		f.manager.syncUnifiedAngles({ projectId: "project-a", mediaId: asset.id }),
	).toBe(a);
	const w = await worker();
	expect(f.updates[0].action).toBe("start");
	expect(f.manager.isUnifiedAnglesSyncing(asset.id)).toBe(true);
	w.input.onProgress({ step: "Aligning audio", progress: 0.6 });
	expect(
		f.manager.getAssets().find((x: any) => x.id === asset.id).unifiedAngles
			.syncTask.progress,
	).toBe(0.6);
	w.resolve(result(asset.id));
	expect(await a).toBe(true);
	expect(f.commits).toHaveLength(1);
	expect(f.commits[0][0].taskId).toBe(f.updates[0].taskId);
	expect(saves.at(-1).projectId).toBe("project-a");
	expect(saves.at(-1).mediaAsset.unifiedAngles.sync.method).toBe("audio");
	expect(f.manager.isUnifiedAnglesSyncing(asset.id)).toBe(false);
});
test("analysis failure is durable and one retry starts a fresh task and succeeds", async () => {
	const f = fixture();
	const asset = await f.manager.addMediaAsset({
		projectId: "project-a",
		asset: virtual,
	});
	const first = f.manager.syncUnifiedAngles({
		projectId: "project-a",
		mediaId: asset.id,
	});
	(await worker()).reject(Error("No shared audio"));
	expect(await first).toBe(false);
	const failed = f.manager.getAssets().find((a: any) => a.id === asset.id);
	expect(failed.unifiedAngles.syncTask.status).toBe("failed");
	expect(saves.at(-1).mediaAsset.unifiedAngles.syncTask.error).toBe(
		"No shared audio",
	);
	const retry = f.manager.syncUnifiedAngles({
		projectId: "project-a",
		mediaId: asset.id,
	});
	const w = await worker();
	const starts = f.updates.filter((u) => u.action === "start");
	expect(starts[1].taskId).not.toBe(starts[0].taskId);
	expect(starts[1].replaceTaskId).toBe(starts[0].taskId);
	w.resolve(result(asset.id));
	expect(await retry).toBe(true);
});
test("project changes abort active workers and late replies cannot apply to the next project", async () => {
	const f = fixture();
	const asset = await f.manager.addMediaAsset({
		projectId: "project-a",
		asset: virtual,
	});
	const job = f.manager.syncUnifiedAngles({
		projectId: "project-a",
		mediaId: asset.id,
	});
	const w = await worker();
	f.switchProject("project-b");
	f.manager.clearAllAssets();
	expect(w.input.signal.aborted).toBe(true);
	w.resolve(result(asset.id));
	expect(await job).toBe(false);
	expect(f.commits).toHaveLength(0);
	expect(saves.every((x) => x.projectId === "project-a")).toBe(true);
});
test("a persisted running task after reload is retryable without pretending a worker exists", async () => {
	const f = fixture();
	const asset = {
		...virtual,
		id: "restored",
		unifiedAngles: {
			...virtual.unifiedAngles,
			syncTask: { id: "orphan", status: "running", progress: 0.4 },
		},
	};
	f.manager.setAssets({ assets: [...cameras, asset] });
	expect(f.manager.isUnifiedAnglesSyncing(asset.id)).toBe(false);
	const job = f.manager.syncUnifiedAngles({
		projectId: "project-a",
		mediaId: asset.id,
	});
	const w = await worker();
	expect(f.updates[0].replaceTaskId).toBe("orphan");
	w.resolve(result(asset.id));
	expect(await job).toBe(true);
});
