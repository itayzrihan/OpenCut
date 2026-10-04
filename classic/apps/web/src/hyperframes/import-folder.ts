import type { EditorCore } from "@/core";
import { canonicalMediaBindings } from "@/core/canonical-classic-session";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import type { PreparedHyperframesFolder } from "./folder";
import { HyperframesRenderClient } from "./render-client";
import { withImportLock } from "./import-recovery";
import type {
	HyperframesImportRecovery,
	HyperframesImportDraft,
} from "./import-recovery-types";

export interface HyperframesImportProgress {
	phase: "checking" | "uploading" | "loading" | "committing" | "saving";
	completed: number;
	total: number;
}

/** Browser file I/O orchestration; canonical capabilities own the actual edit. */
type ImportOptions = {
	editor: EditorCore;
	folder: PreparedHyperframesFolder;
	startSeconds?: number;
	signal?: AbortSignal;
	onProgress?: (progress: HyperframesImportProgress) => void;
	recovery?: HyperframesImportRecovery;
};

export async function importHyperframesFolder(input: ImportOptions) {
	const accountId = window.__opencutAccountId;
	const projectId = input.editor.project.getActiveOrNull()?.metadata.id;
	if (!accountId || !projectId)
		throw new Error("Open a project before importing a HyperFrames folder");
	const uploadToken = input.recovery?.uploadToken ?? generateUUID();
	return withImportLock({
		accountId,
		projectId,
		uploadToken,
		resuming: !!input.recovery,
		run: () => runImport({ ...input, uploadToken }),
	});
}

async function runImport({
	editor,
	folder,
	startSeconds,
	signal,
	onProgress,
	recovery,
	uploadToken,
}: ImportOptions & { uploadToken: string }) {
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	const sceneId = editor.scenes.getActiveSceneOrNull()?.id;
	const accountId = window.__opencutAccountId;
	if (!projectId || !sceneId || !accountId)
		throw new Error("Open a project before importing a HyperFrames folder");
	const target = { projectId, sceneId, signal };
	const scope = { accountId, signal, uploadToken };
	const resources = folder.resources.map((asset) => ({ ...asset }));
	const staged: string[] = [];
	let committed = false;
	let started = !!recovery;
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
	const finish = async (result: {
		assetId: string;
		itemId?: string;
		trackId?: string;
	}) => {
		report({ phase: "saving", completed: resources.length });
		let saveError: string | undefined;
		try {
			if (
				window.__opencutAccountId !== accountId ||
				editor.project.getActiveOrNull()?.metadata.id !== projectId
			)
				throw new Error(
					"The workspace changed before the imported project could be saved",
				);
			await editor.save.flush();
			await storageService.finishMediaUpload({
				projectId,
				uploadToken,
				discard: false,
				scope: { accountId },
			});
		} catch (error) {
			saveError = error instanceof Error ? error.message : String(error);
		}
		return { ...result, saveError };
	};
	try {
		assertTarget();
		report({ phase: "checking" });
		if (recovery) {
			recovery = await storageService.readMediaUpload({
				projectId,
				uploadToken,
				scope,
			});
			if (recovery.draft.sceneId !== sceneId)
				throw new Error("Open the original scene to continue this import");
			assertTarget();
			const library = await editor.command.readHyperframesLibrary({
				projectId,
			});
			const existing = library.items.find(
				(item) => item.importId === uploadToken,
			);
			assertTarget();
			if (existing) {
				committed = true;
				const occurrence = existing.occurrences.find(
					(item) => item.sceneId === sceneId,
				);
				return await finish({
					assetId: existing.assetId,
					itemId: occurrence?.elementId,
					trackId: occurrence?.trackId,
				});
			}
			startSeconds = recovery.draft.startSeconds;
		}
		const input = {
			target,
			importId: uploadToken,
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
		const draft: HyperframesImportDraft = recovery?.draft ?? {
			kind: "hyperframes",
			name: folder.name,
			sceneId,
			startSeconds,
			source: folder.source,
			resources: resources.map((asset) => ({
				id: asset.id,
				name: asset.name,
				type: asset.type,
				size: asset.file?.size ?? asset.size ?? 0,
				lastModified: asset.file?.lastModified ?? asset.lastModified ?? 0,
				fileName: asset.file?.name ?? asset.fileName ?? asset.name,
				mimeType:
					asset.file?.type ?? asset.mimeType ?? "application/octet-stream",
			})),
		};
		await storageService.beginMediaUpload({
			projectId,
			uploadToken,
			draft,
			scope,
		});
		started = true;
		for (const asset of resources) {
			assertTarget();
			report({ phase: "uploading", completed: staged.length });
			staged.push(asset.id);
			if (recovery?.readyAssetIds.includes(asset.id)) asset.file = undefined;
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
		return await finish(result);
	} catch (error) {
		if (!committed && started && !recovery) {
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
