/** An isolated browser process reuses the production compositor exactly. */
import { EditorCore } from "@/core";
import { initializeGpuRenderer } from "@/services/renderer/gpu-renderer";
import { loadProjectFont } from "@/fonts/custom-fonts";
import { accountAssetUrl } from "@/accounts/browser";
import { renderQueueRequest } from "./client";
import type { RenderJob } from "./types";
export async function executeQueuedRender(
	job: RenderJob,
	onProgress: (message: string) => void,
	destination?: FileSystemFileHandle,
	editor = EditorCore.getInstance(),
) {
	editor.save.stop();
	editor.save.pause();
	const attempt = job.attempt!;
	let cancelled = false,
		progress = 0,
		message = "Preparing render",
		reporting = Promise.resolve();
	const uploadCancel = new AbortController();
	const report = (
		status: "rendering" | "failed" | "cancelled" | "completed" = "rendering",
		detail = message,
	) => {
		const currentProgress = progress;
		const task = reporting.then(async () => {
			let state: { cancelRequested: boolean } | undefined;
			for (let retry = 0; retry < 5; retry++) {
				try {
					state = await renderQueueRequest<{ cancelRequested: boolean }>({
						action: "report",
						id: job.id,
						projectId: job.projectId,
						attempt,
						progress: currentProgress,
						message: detail.slice(0, 4000),
						status,
					});
					break;
				} catch (error) {
					const status = (error as { status?: number }).status;
					if (retry === 4 || (status !== undefined && status < 500))
						throw error;
					await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** retry));
				}
			}
			if (!state) throw Error("Render heartbeat was not acknowledged");
			if (state.cancelRequested) {
				cancelled = true;
				editor.project.cancelExport();
				uploadCancel.abort();
			}
		});
		reporting = task.catch(() => {});
		return task;
	};
	const heartbeat = setInterval(() => {
		void report().catch(() => {
			cancelled = true;
			editor.project.cancelExport();
			uploadCancel.abort();
		});
	}, 5000);
	const unsubscribe = editor.project.subscribe(() => {
		const state = editor.project.getExportState();
		if (state.isExporting) {
			progress = Math.max(progress, Math.min(0.98, state.progress * 0.98));
			message = state.phase ?? "Rendering";
			onProgress(`${message} · ${Math.round(progress * 100)}%`);
		}
	});
	let dispose: (() => Promise<void>) | undefined;
	try {
		await report();
		await initializeGpuRenderer();
		const fileUrl = (id: string, kind: "media" | "font") =>
			accountAssetUrl(
				`/api/render-queue/file?job=${encodeURIComponent(job.id)}&id=${encodeURIComponent(id)}&kind=${kind}`,
			);
		for (const font of job.snapshot.document.customFonts ?? []) {
			await loadProjectFont({
				font: { ...font, url: fileUrl(font.id, "font") },
			});
		}
		const assets = job.snapshot.mediaAssets.map((asset) => ({
			...asset,
			url: asset.unifiedAngles ? undefined : fileUrl(asset.id, "media"),
			missing: false,
		}));
		await editor.project.loadRenderSnapshot({
			snapshot: job.snapshot,
			sceneId: job.sceneId,
			assets,
		});
		if (cancelled) throw Error("Render cancelled");
		if (
			job.delivery === "direct" &&
			(!destination || destination.name !== job.destinationName)
		)
			throw Error("The selected direct export destination is unavailable");
		const result = await editor.project.export({
			options: job.options,
			destination,
		});
		dispose = result.dispose;
		if (result.cancelled || cancelled) {
			await report("cancelled", "Cancelled");
			return;
		}
		if (job.delivery === "direct" && result.success && result.savedFileName) {
			progress = 1;
			await report("completed", `Saved ${result.savedFileName}`);
			onProgress(`Saved ${result.savedFileName}`);
			return;
		}
		if (!result.success || !result.file)
			throw Error(
				result.error ?? "Render did not produce a disk-backed output",
			);
		progress = 0.99;
		message = "Saving output";
		onProgress(message);
		await report();
		if (cancelled) {
			await report("cancelled", "Cancelled");
			return;
		}
		const response = await fetch(
			accountAssetUrl(
				`/api/render-queue/file?job=${encodeURIComponent(job.id)}&attempt=${encodeURIComponent(attempt)}`,
			),
			{
				method: "PUT",
				body: result.file,
				signal: uploadCancel.signal,
				headers: {
					"Content-Type": result.file.type || "application/octet-stream",
				},
			},
		);
		const receipt = await response.json();
		if (!response.ok)
			throw Error(receipt.error ?? "Could not save render output");
		onProgress(receipt.status === "cancelled" ? "Cancelled" : "Complete");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		onProgress(detail);
		await report(
			cancelled ? "cancelled" : "failed",
			cancelled ? "Cancelled" : detail,
		).catch(() => {});
	} finally {
		clearInterval(heartbeat);
		unsubscribe();
		await reporting;
		await dispose?.();
	}
}
