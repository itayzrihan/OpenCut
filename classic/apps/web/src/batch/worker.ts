/** Browser host adapter: one isolated canonical EditorCore, one job at a time. */
import { EditorCore } from "@/core";
import { runFullAutoEdit } from "@/ai/full-auto-edit";
import { registerLocalMediaPaths } from "@/services/local-drive/client";
import { processMediaAssets, processLocalDriveMedia } from "@/media/processing";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { initializeGpuRenderer } from "@/services/renderer/gpu-renderer";
import { batchEditIsLocked } from "opencut-wasm";
import { batchRequest } from "./client";
import { createBatchUpdateQueue } from "./update-queue";
import { setBatchWriteToken } from "./write-token";
import type { BatchRun, BatchState, BatchSource } from "./types";
export async function executeBatch({
	run,
	token,
	files,
}: {
	run: BatchRun;
	token: string;
	files: BatchSource[];
}) {
	const editor = EditorCore.getInstance();
	setBatchWriteToken(token);
	let current: string | undefined;
	let abort: AbortController | undefined;
	let state: BatchRun = run;
	let executionRunId: string | undefined;
	const send = createBatchUpdateQueue(async (data) => {
		const result = await batchRequest<BatchState>({
			action: "update",
			id: run.id,
			...data,
		});
		state = result.runs.find((r) => r.id === run.id)!;
		executionRunId = result.executionRunId;
		if (
			current &&
			state.jobs.find((j) => j.projectId === current)?.cancelRequested
		)
			abort?.abort();
		return result;
	});
	const heartbeat = setInterval(() => {
		void send({}, true).catch(() => abort?.abort());
	}, 10_000);
	const errorMessage = (error: unknown) =>
		error instanceof Error ? error.message : String(error);
	// Keep the canonical editor and batch write authority alive until its final
	// save is acknowledged. Never discard a dirty worker or silently take over
	// another editor's lease to make an exit succeed.
	const prepareExit = async (originalError?: unknown) => {
		let attempt = 0;
		while (true) {
			try {
				await editor.project.prepareExit();
				parent.postMessage(
					{ type: "opencut-batch-recovered", id: run.id },
					location.origin,
				);
				return;
			} catch (saveError) {
				console.error("Background edit could not be saved", {
					projectId: current,
					originalError,
					saveError,
				});
				// A transient failure may have committed without delivering its
				// response. The session client reconciles that exact request first.
				if (attempt++ === 0) continue;
				const message = [
					originalError
						? errorMessage(originalError)
						: "Background edit paused",
					`Save failed: ${errorMessage(saveError)}`,
					"Unsaved changes are retained in this tab. Keep it open and retry saving.",
				]
					.join(" · ")
					.slice(0, 4000);
				await send({ projectId: current, message }).catch(() => {});
				await new Promise<void>((resolve) => {
					const retry = (event: MessageEvent) => {
						if (
							event.origin !== location.origin ||
							event.source !== parent ||
							event.data?.type !== "opencut-batch-retry-save" ||
							event.data.id !== run.id
						)
							return;
						window.removeEventListener("message", retry);
						resolve();
					};
					window.addEventListener("message", retry);
					parent.postMessage(
						{ type: "opencut-batch-save-blocked", id: run.id, message },
						location.origin,
					);
				});
			}
		}
	};
	const stop = () => abort?.abort();
	window.addEventListener("pagehide", stop);
	try {
		// Every owner keeps its lease alive while waiting; only the oldest active run uses AI/GPU.
		await send();
		while (true) {
			for (const job of state.jobs)
				if (job.cancelRequested && batchEditIsLocked({ status: job.status })) {
					await send({
						projectId: job.projectId,
						event: "cancel",
						message: "Cancelled before editing",
					});
				}
			if (!state.jobs.some((j) => batchEditIsLocked({ status: j.status })))
				return;
			if (executionRunId === run.id) break;
			await new Promise((resolve) => setTimeout(resolve, 2000));
			await send();
		}
		await initializeGpuRenderer();
		// Create all project entries immediately. Shared custom fonts are inherited by ProjectManager.
		for (const job of run.jobs) {
			if (
				job.source === "existing" ||
				!batchEditIsLocked({
					status: state.jobs.find((j) => j.projectId === job.projectId)!.status,
				})
			)
				continue;
			await editor.project.createNewProject({
				id: job.projectId,
				name: job.name,
			});
			await editor.save.flush();
			await editor.command.flushHistory();
			await send({ projectId: job.projectId, created: true });
			editor.project.closeProject();
		}
		// Persist source media before editing so queued projects survive navigation.
		for (const [i, job] of run.jobs.entries()) {
			if (
				job.source === "existing" ||
				!batchEditIsLocked({ status: state.jobs[i].status })
			)
				continue;
			current = job.projectId;
			abort = new AbortController();
			await send();
			if (state.jobs[i].cancelRequested) {
				await send({
					projectId: current,
					event: "cancel",
					message: "Cancelled before import",
				});
				continue;
			}
			try {
				await send({
					projectId: current,
					event: "import",
					message: "Importing source video…",
				});
				if (!(await editor.project.loadProject({ id: current })))
					throw new Error("Project could not be loaded");
				const source = files[i];
				const [asset] =
					source instanceof File
						? await processMediaAssets({ files: [source] })
						: await processLocalDriveMedia({
								projectId: current,
								records: await registerLocalMediaPaths({
									projectId: current,
									paths: [source.sourcePath],
								}),
							});
				abort.signal.throwIfAborted();
				if (!asset || asset.type !== "video" || !asset.duration)
					throw new Error(
						"Could not decode video. Use a supported video file smaller than 1 GB.",
					);
				const saved = await editor.media.addMediaAsset({
					projectId: current,
					asset,
				});
				if (!saved) throw new Error("Source media could not be saved");
				abort.signal.throwIfAborted();
				editor.timeline.insertElement({
					element: buildElementFromMedia({
						mediaId: saved.id,
						mediaType: "video",
						name: saved.name,
						duration: mediaTimeFromSeconds({ seconds: asset.duration }),
						startTime: ZERO_MEDIA_TIME,
					}),
					placement: { mode: "auto", trackType: "video" },
				});
				await editor.project.updateThumbnail({
					thumbnail: asset.thumbnailUrl ?? "",
				});
				await editor.save.flush();
				await editor.command.flushHistory();
				await send({
					projectId: current,
					event: "ready",
					message: "Imported · waiting for Full Auto Edit",
				});
			} catch (e) {
				await prepareExit(e);
				await send({
					projectId: current,
					event: abort.signal.aborted ? "cancel" : "fail",
					message: e instanceof Error ? e.message : "Import failed",
				});
			} finally {
				if (!editor.save.getIsDirty()) editor.project.closeProject();
			}
		}
		for (const job of run.jobs) {
			current = job.projectId;
			abort = new AbortController();
			if (state.jobs.find((j) => j.projectId === current)?.status !== "ready")
				continue;
			await send();
			if (abort.signal.aborted) {
				await send({
					projectId: current,
					event: "cancel",
					message: "Cancelled before editing",
				});
				continue;
			}
			try {
				await send({
					projectId: current,
					event: "run",
					message: job.resumeFromStage
						? `Resuming Full Auto Edit from stage ${job.resumeFromStage + 1}…`
						: "Starting Full Auto Edit…",
				});
				if (!(await editor.project.loadProject({ id: current })))
					throw new Error("Imported project is unavailable");
				const notes = await runFullAutoEdit({
					editor,
					signal: abort.signal,
					// onStep includes every progress message and its durable checkpoint.
					onProgress: () => {},
					onStep: (p) => {
						void send(
							{
								projectId: current,
								completedStages: p.completedStages,
								message: p.message.slice(0, 4000),
							},
							true,
						).catch(() => abort?.abort());
					},
					options: run.options,
					resumeFromStage: job.resumeFromStage,
				});
				abort.signal.throwIfAborted();
				await prepareExit();
				await send({
					projectId: current,
					event: "complete",
					message: ["Ready for review", ...notes].join(" · ").slice(0, 4000),
				});
			} catch (e) {
				// Save and release editor ownership while the batch token is still
				// valid, before the terminal transition unlocks the visible editor.
				await prepareExit(e);
				await send({
					projectId: current,
					event: abort.signal.aborted ? "cancel" : "fail",
					message: (e instanceof Error
						? e.message
						: "Full Auto Edit failed"
					).slice(0, 4000),
				});
			} finally {
				if (!editor.save.getIsDirty()) editor.project.closeProject();
			}
		}
	} catch (e) {
		await prepareExit(e);
		const message = e instanceof Error ? e.message : "Batch worker stopped";
		for (const job of state.jobs)
			if (batchEditIsLocked({ status: job.status })) {
				await send({
					projectId: job.projectId,
					event: "fail",
					message: message.slice(0, 4000),
				}).catch(() => {});
			}
	} finally {
		clearInterval(heartbeat);
		window.removeEventListener("pagehide", stop);
		await send.flush();
		editor.save.stop();
		setBatchWriteToken("");
		parent.postMessage(
			{ type: "opencut-batch-finished", id: run.id },
			location.origin,
		);
	}
}
