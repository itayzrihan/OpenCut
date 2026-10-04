import type { EditorCore } from "@/core";
import { canonicalMediaBindings } from "@/core/canonical-classic-session";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import type { PreparedHyperframesFolder } from "./folder";
import { HyperframesRenderClient } from "./render-client";

export interface HyperframesImportProgress {
	phase: "checking" | "uploading" | "loading" | "committing" | "saving";
	completed: number;
	total: number;
}

/** Browser file I/O orchestration; canonical capabilities own the actual edit. */
export async function importHyperframesFolder({
	editor,
	folder,
	startSeconds,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	folder: PreparedHyperframesFolder;
	startSeconds?: number;
	signal?: AbortSignal;
	onProgress?: (progress: HyperframesImportProgress) => void;
}) {
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	const accountId = window.__opencutAccountId;
	if (!projectId || !sceneId || !accountId)
		throw new Error("Open a project before importing a HyperFrames folder");
	const target = { projectId, sceneId, signal };
	const uploadToken = generateUUID();
	const scope = { accountId, signal, uploadToken };
	const resources = folder.resources.map((asset) => ({ ...asset }));
	const staged: string[] = [];
	let committed = false;
	const client = new HyperframesRenderClient(projectId);
	const cancel = () => client.dispose();
	signal?.addEventListener("abort", cancel, { once: true });
	const assertTarget = () => {
		signal?.throwIfAborted();
		if (
			window.__opencutAccountId !== accountId ||
			editor.project.getActiveOrNull()?.metadata.id !== projectId ||
			editor.scenes.getActiveSceneOrNull()?.id !== sceneId
		)
			throw new Error(
				"The active account, project or scene changed during import",
			);
	};
	const report = ({
		phase,
		completed = 0,
	}: {
		phase: HyperframesImportProgress["phase"];
		completed?: number;
	}) => onProgress?.({ phase, completed, total: resources.length });
	try {
		assertTarget();
		report({ phase: "checking" });
		const input = {
			target,
			name: folder.name,
			source: folder.source,
			startSeconds,
			classicResourceAssets: canonicalMediaBindings(resources),
		};
		// Validate identity and media bindings before any upload. The temporary
		// duration is only for this dry run; generated duration is measured below.
		await editor.command.importHyperframes({
			...input,
			dryRun: true,
			resolvedDurationSeconds: folder.inspection.durationSeconds ?? 1,
		});
		assertTarget();
		for (const asset of resources) {
			assertTarget();
			report({ phase: "uploading", completed: staged.length });
			staged.push(asset.id);
			await storageService.saveMediaAsset({
				projectId,
				mediaAsset: asset,
				scope,
			});
		}
		assertTarget();
		report({ phase: "loading", completed: resources.length });
		const ready = await client.prepareSource(folder.source);
		assertTarget();
		report({ phase: "committing", completed: resources.length });
		const result = await editor.command.importHyperframes({
			...input,
			classicResourceAssets: canonicalMediaBindings(resources),
			resolvedDurationSeconds: ready.durationSeconds,
			runtimeManifest: ready.runtimeManifest,
		});
		committed = true;
		report({ phase: "saving", completed: resources.length });
		const saveErrors: string[] = [];
		try {
			if (
				window.__opencutAccountId !== accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId
			)
				throw new Error(
					"The workspace changed before the imported project could be saved",
				);
			await editor.save.flush();
			// Keep upload ownership until the canonical edit is durably saved.
			// A failed save must remain identifiable for recovery after a restart.
			if (staged.length)
				await storageService.finishMediaUpload({
					projectId,
					uploadToken,
					discard: false,
					scope: { accountId },
				});
		} catch (error) {
			// The edit already exists. Never delete its resources or encourage a
			// duplicate import when the existing autosave path needs a retry.
			saveErrors.push(error instanceof Error ? error.message : String(error));
		}
		return {
			...result,
			saveError: saveErrors.length ? saveErrors.join(". ") : undefined,
		};
	} catch (error) {
		if (!committed && staged.length) {
			try {
				await storageService.finishMediaUpload({
					projectId,
					uploadToken,
					discard: true,
					scope: { accountId },
				});
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Import did not complete. Some uploaded resources could not be removed from project storage.",
				);
			}
		}
		throw error;
	} finally {
		signal?.removeEventListener("abort", cancel);
		client.dispose();
	}
}
