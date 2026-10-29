/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Rust validates native recipe/snapshot contracts; storage validates saved projects. */
/** Browser IO for native scene jobs. Project state and publication belong to Rust. */
import type { EditorCore } from "@/core";
import { storageService, deserializeProject } from "@/services/storage/service";
import type { SerializedProject } from "@/services/storage/types";
import type { FullAutoOptions } from "@/ai/full-auto-edit";
import { canonicalMediaBindings } from "@/core/canonical-classic-session";
import { batchRequest } from "./client";
import type { BatchRun } from "./types";

export const sceneActions = [
	["full-auto", "Full Auto Edit"],
	["center-subject", "Center Subject"],
	["framing", "Vertical Framing"],
	["zoom", "Automatic Zoom"],
	["transitions", "Automatic Transition Edit"],
	["word-animation", "Automatic Word Animation and Reveal"],
	["sound-effects", "Automatic Sound Effects · Earshot"],
	["music", "Automatic Music"],
	["auto-texts", "Auto Texts"],
] as const;
export type SceneAction = (typeof sceneActions)[number][0];
export interface SceneJob {
	id: string;
	sceneId: string;
	workerProjectId: string;
	outputSceneId: string;
	action: SceneAction;
	options: FullAutoOptions;
	status?: "queued" | "published";
	sourceFingerprint?: string;
}
export function automationControl({
	editor,
	change,
}: {
	editor: EditorCore;
	change: Record<string, unknown>;
}) {
	return editor.command.invokeCanonicalControl({
		projectId: editor.project.getActive().metadata.id,
		accountId: window.__opencutAccountId ?? "local",
		capabilityId: "project.classic.automation.edit",
		input: { change },
	});
}
export function queueOwner() {
	const key = "opencut-scene-worker-owner";
	let id = sessionStorage.getItem(key);
	if (!id) sessionStorage.setItem(key, (id = crypto.randomUUID()));
	return id;
}
export async function enqueueScenes({
	editor,
	sceneIds,
	action,
	options,
}: {
	editor: EditorCore;
	sceneIds: string[];
	action: SceneAction;
	options: FullAutoOptions;
}) {
	const projectId = editor.project.getActive().metadata.id;
	const jobs: SceneJob[] = [...new Set(sceneIds)].map((sceneId) => ({
		id: crypto.randomUUID(),
		sceneId,
		workerProjectId: crypto.randomUUID(),
		outputSceneId: crypto.randomUUID(),
		action,
		options,
	}));
	// Capture all selections in one canonical revision before any asynchronous IO.
	const result = automationControl({
		editor,
		change: { type: "enqueue", jobs },
	}) as {
		workers: Array<{ jobId: string; project: SerializedProject }>;
	};
	await editor.save.flush();
	await editor.command.flushHistory();
	const [assets, fonts] = await Promise.all([
		storageService.loadAllMediaAssets({ projectId }),
		storageService.loadAllProjectFonts({ projectId }),
	]);
	for (const worker of result.workers) {
		const job = jobs.find((j) => j.id === worker.jobId)!;
		await storageService.saveProject({
			project: deserializeProject(worker.project),
		});
		// Linked, account-authorized source records avoid uploading/copying gigabytes per scene.
		for (const mediaAsset of assets)
			await storageService.saveMediaAsset({
				projectId: job.workerProjectId,
				mediaAsset: {
					...mediaAsset,
					file: undefined,
					storageKind: mediaAsset.sourcePath
						? "linked"
						: mediaAsset.storageKind,
				},
			});
		for (const font of fonts)
			await storageService.saveProjectFont({
				projectId: job.workerProjectId,
				font,
			});
	}
	return batchRequest({
		action: "scenes",
		projectId,
		jobIds: jobs.map((j) => j.id),
		ownerId: queueOwner(),
	});
}

/** Results stay durable in their working projects until their owning editor can
 * publish them. Changing the viewer scene is never needed. */
export async function publishSceneResults({
	editor,
	runs,
}: {
	editor: EditorCore;
	runs: BatchRun[];
}) {
	const project = editor.project.getActiveOrNull();
	if (
		!project ||
		editor.project.getIsLoading() ||
		editor.project.getSessionReadOnlyReason()
	)
		return;
	for (const run of runs)
		for (const job of run.jobs) {
			if (
				job.sourceProjectId !== project.metadata.id ||
				job.status !== "completed" ||
				!job.automationJobId
			)
				continue;
			const intent = editor.project
				.getActiveOrNull()
				?.automationEdits?.find((j) => j.id === job.automationJobId);
			if (!intent || intent.status === "published") continue;
			const result = await storageService.loadProject({ id: job.projectId });
			const assets = await storageService.loadAllMediaAssets({
				projectId: job.projectId,
			});
			if (editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id)
				return;
			for (const asset of assets) {
				if (editor.media.getAssets().some((a) => a.id === asset.id)) continue;
				const added = await editor.media.addMediaAsset({
					projectId: project.metadata.id,
					asset: {
						...asset,
						file: undefined,
						storageKind: asset.sourcePath ? "linked" : asset.storageKind,
					},
				});
				if (!added) throw new Error(`Could not publish ${asset.name}`);
			}
			if (
				!result ||
				editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id
			)
				return;
			automationControl({
				editor,
				change: {
					type: "publish",
					jobId: intent.id,
					worker: {
						document: JSON.parse(JSON.stringify(result.project)),
						mediaAssets: canonicalMediaBindings(assets),
					},
				},
			});
			await editor.save.flush();
			await editor.command.flushHistory();
		}
}
