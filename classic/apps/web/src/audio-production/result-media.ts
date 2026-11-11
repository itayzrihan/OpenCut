import { isHostedBrowserWorkspace } from "@/accounts/browser";
import type { MediaAsset } from "@/media/types";
import { downloadProjectOutput } from "@/media/project-output";
import {
	assertLocalDriveWriteScope,
	type LocalDriveRequestScope,
} from "@/services/local-drive/client";
import { storageService } from "@/services/storage/service";
import { audioFileUrl } from "./client";
import type { AudioJob } from "./types";

const saving = new Map<string, Promise<MediaAsset>>();

/** An audio job's owned file is cached without changing project membership. */
export async function saveAudioResult({
	projectId,
	job,
	scope,
	signal,
}: {
	projectId: string;
	job: AudioJob;
	scope: LocalDriveRequestScope;
	signal: AbortSignal;
}): Promise<MediaAsset> {
	const output = job.output;
	if (
		job.projectId !== projectId ||
		job.status !== "ready" ||
		output?.kind !== "audio"
	)
		throw new Error("This audio result is unavailable in the active project");
	assertLocalDriveWriteScope({ projectId, scope });
	signal.throwIfAborted();
	const id = `elevenlabs-${job.id}`;
	const hosted = isHostedBrowserWorkspace();
	const key = JSON.stringify([scope.accountId, projectId, id]);
	const pending = saving.get(key);
	if (pending) return pending;
	const result = (async () => {
		const stored = hosted
			? await storageService.loadBrowserMediaAsset({ projectId, id, scope })
			: null;
		if (stored?.file?.size === output.bytes && !stored.missing) return stored;
		const file = await downloadProjectOutput({
			output,
			url: audioFileUrl({ projectId, id: output.id }),
			signal,
			lastModified: job.createdAt,
		});
		assertLocalDriveWriteScope({ projectId, scope });
		const asset: MediaAsset = {
			id,
			name: output.name,
			fileName: output.name,
			type: "audio",
			file,
		};
		if (!hosted) return asset;
		const { hasLocalCopy: _copy, ...binding } =
			await storageService.saveBrowserMediaAsset({
				projectId,
				mediaAsset: asset,
				scope,
			});
		return { ...asset, ...binding };
	})().finally(() => saving.delete(key));
	saving.set(key, result);
	return result;
}
