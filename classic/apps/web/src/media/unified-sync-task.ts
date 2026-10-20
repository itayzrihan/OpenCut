/** Host worker/IO orchestration only. Task state and offset validation live in OpenCutRuntime. */
import type { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import {
	isUnifiedAnglesAsset,
	unifiedAnglesSyncStatus,
} from "./unified-angles";
import { toast } from "sonner";

export type UnifiedSyncTaskUpdate = {
	mediaId: string;
	taskId: string;
	action: "start" | "progress" | "fail" | "cancel";
	replaceTaskId?: string;
	progress?: number;
	stage?: string;
	error?: string;
};
type Job = {
	controller: AbortController;
	taskId: string;
	promise: Promise<boolean>;
};
export class UnifiedAnglesSyncTasks {
	private jobs = new Map<string, Job>();
	private editor: EditorCore;
	private onSettled: () => void;
	constructor({
		editor,
		onSettled = () => {},
	}: {
		editor: EditorCore;
		onSettled?: () => void;
	}) {
		this.editor = editor;
		this.onSettled = onSettled;
	}
	private key({ projectId, mediaId }: { projectId: string; mediaId: string }) {
		return JSON.stringify([
			typeof window === "undefined" ? null : window.__opencutAccountId,
			projectId,
			mediaId,
		]);
	}
	isRunning(mediaId: string) {
		const projectId = this.editor.project.getActiveOrNull()?.metadata.id;
		const job = projectId
			? this.jobs.get(this.key({ projectId, mediaId }))
			: undefined;
		return (
			!!job &&
			!job.controller.signal.aborted &&
			this.editor.media
				.getAssets()
				.some(
					(a) =>
						a.id === mediaId && a.unifiedAngles?.syncTask?.id === job.taskId,
				)
		);
	}
	cancelAll() {
		for (const job of this.jobs.values()) job.controller.abort();
	}
	start({
		projectId,
		mediaId,
	}: {
		projectId: string;
		mediaId: string;
	}): Promise<boolean> {
		const key = this.key({ projectId, mediaId }),
			prior = this.jobs.get(key);
		if (prior && !prior.controller.signal.aborted) return prior.promise;
		const job: Job = {
			controller: new AbortController(),
			taskId: generateUUID(),
			promise: Promise.resolve(false),
		};
		this.jobs.set(key, job);
		job.promise = this.run({ projectId, mediaId, job }).finally(() => {
			if (this.jobs.get(key) === job) this.jobs.delete(key);
			this.onSettled();
		});
		return job.promise;
	}
	private async run({
		projectId,
		mediaId,
		job,
	}: {
		projectId: string;
		mediaId: string;
		job: Job;
	}) {
		const account =
			typeof window === "undefined" ? null : window.__opencutAccountId;
		const inScope = () =>
			this.editor.project.getActiveOrNull()?.metadata.id === projectId &&
			(typeof window === "undefined" ? null : window.__opencutAccountId) ===
				account &&
			!this.editor.project.getSessionReadOnlyReason();
		const current = () =>
			this.editor.media.getAssets().find((a) => a.id === mediaId);
		const owns = () =>
			inScope() && current()?.unifiedAngles?.syncTask?.id === job.taskId;
		const check = () => {
			job.controller.signal.throwIfAborted();
			if (!owns()) throw Error("Audio sync project or task changed");
		};
		const abort = () => job.controller.abort();
		try {
			if (!inScope())
				throw Error(
					"Open the editable target project before synchronizing audio",
				);
			const asset = current();
			if (!isUnifiedAnglesAsset(asset))
				throw Error("Unified Angles asset is missing");
			const mediaMap = new Map(
				this.editor.media.getAssets().map((a) => [a.id, a]),
			);
			if (unifiedAnglesSyncStatus({ asset, mediaMap }) === "synced")
				return true;
			if (typeof window !== "undefined")
				window.addEventListener("pagehide", abort, { once: true });
			this.editor.command.updateUnifiedSyncTask({
				mediaId,
				taskId: job.taskId,
				action: "start",
				replaceTaskId: asset.unifiedAngles.syncTask?.id,
			});
			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: current()!,
			});
			check();
			const [
				{ runPodcastAlignment, resolvePodcastChannelSources },
				{ podcastMulticamDefaults },
			] = await Promise.all([
				import("@/podcast-sync/engine"),
				import("opencut-wasm"),
			]);
			check();
			const channels = resolvePodcastChannelSources({
				channels: [
					{ id: mediaId, name: asset.name, video: asset, audio: asset },
				],
				mediaAssets: this.editor.media.getAssets(),
			});
			let bucket = -1;
			const result = await runPodcastAlignment({
				channels,
				settings: podcastMulticamDefaults({ quick: true }),
				signal: job.controller.signal,
				onProgress: ({ step, progress }) => {
					check();
					const next = Math.floor(progress * 10);
					if (next <= bucket) return;
					bucket = next;
					this.editor.command.updateUnifiedSyncTask({
						mediaId,
						taskId: job.taskId,
						action: "progress",
						progress,
						stage: step,
					});
				},
			});
			check();
			const update = result.unifiedSync.find((u) => u.mediaId === mediaId);
			if (!update)
				throw Error("Audio analysis did not return every unified camera");
			this.editor.command.syncUnifiedAngles([
				{ ...update, taskId: job.taskId },
			]);
			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: current()!,
			});
			if (inScope()) {
				await this.editor.command.flushHistory();
				toast.success("Audio synced", { description: asset.name });
				for (const warning of result.precisionWarnings ?? [])
					toast.warning(warning, { duration: 12000 });
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (owns()) {
				try {
					this.editor.command.updateUnifiedSyncTask({
						mediaId,
						taskId: job.taskId,
						action: job.controller.signal.aborted ? "cancel" : "fail",
						error: message.slice(0, 500),
					});
					await storageService.saveMediaAsset({
						projectId,
						mediaAsset: current()!,
					});
					await this.editor.command.flushHistory();
				} catch (saveError) {
					console.error("Could not persist audio sync status", saveError);
				}
			}
			if (inScope() && !job.controller.signal.aborted)
				toast.error("Could not sync audio", { description: message });
			return false;
		} finally {
			if (typeof window !== "undefined")
				window.removeEventListener("pagehide", abort);
		}
	}
}
