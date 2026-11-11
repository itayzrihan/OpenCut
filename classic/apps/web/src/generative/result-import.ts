import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { DirectorJob } from "./types";
import { isHostedBrowserWorkspace } from "@/accounts/browser";
import { downloadProjectOutput } from "@/media/project-output";
import { storageService } from "@/services/storage/service";
import {
	assertLocalDriveWriteScope,
	captureLocalDriveWriteScope,
} from "@/services/local-drive/client";
import { fileUrl, canonical } from "./client";
import { insertSeamless } from "./seamless-connect";
import { applyReplacement } from "./replace-clip";
const imports = new Set<string>();
/** Host bytes pass through the normal canonical Media import; no parallel asset store. */
export async function importDirectorResult({
	editor,
	projectId,
	accountId,
	job,
	signal,
	current,
	process,
	notify = () => {},
	notifyWarning = () => {},
}: {
	editor: EditorCore;
	projectId: string;
	accountId: string;
	job: DirectorJob;
	signal: AbortSignal;
	current: () => boolean;
	process: (input: { files: File[] }) => Promise<Omit<MediaAsset, "id">[]>;
	notify?: (message: string) => void;
	notifyWarning?: (message: string) => void;
}) {
	if (!current() || job.projectId !== projectId) return;
	const document = canonical({ editor }).document,
		link = document.jobs.find((j) => j.id === job.id);
	if (!link || link.status !== job.status)
		canonical({
			editor,
			change: {
				type: "job",
				job: {
					id: job.id,
					digest: job.digest,
					status: job.status,
					mediaId: link?.mediaId ?? null,
				},
			},
		});
	if (job.status !== "ready" || !job.output) return;
	const mediaId = link?.mediaId ?? "generative-" + job.id,
		key = accountId + ":" + projectId + ":" + job.id;
	const hosted = isHostedBrowserWorkspace();
	const existing = editor.media
		.getAssets()
		.find((asset) => asset.id === mediaId);
	// A retained link also records an explicit removal. Only repair an asset
	// that is still part of the current canonical project.
	if (
		link?.mediaId &&
		(!existing || !hosted || (existing.file && !existing.missing))
	)
		return;
	if (imports.has(key)) return;
	imports.add(key);
	try {
		const output = job.output;
		const scope = {
			...captureLocalDriveWriteScope({ projectId, accountId }),
			signal,
		};
		if (!existing || (hosted && (!existing.file || existing.missing))) {
			const local = hosted
				? await storageService.loadBrowserMediaAsset({
						projectId,
						id: mediaId,
						scope,
					})
				: null;
			const file =
				local?.file?.size === output.bytes
					? local.file
					: await downloadProjectOutput({
							output,
							url: fileUrl({ projectId, id: output.id }),
							signal,
							lastModified: job.createdAt,
						});
			if (!current()) return;
			assertLocalDriveWriteScope({ projectId, scope });
			if (existing) {
				await editor.media.reopenBrowserSource({
					projectId,
					id: mediaId,
					file,
				});
				if (!current() || link?.mediaId) return;
			} else {
				const assets = await process({ files: [file] });
				if (!current()) return;
				await editor.media.addGeneratedMediaAsset({
					projectId,
					asset: {
						type: output.kind,
						name: output.name,
						...assets[0],
						file,
						id: mediaId,
					},
					scope,
				});
				if (!current()) return;
			}
		}
		if (
			job.kind === "storyboard" &&
			!document.references.some((r) => r.id === output.id)
		)
			canonical({ editor, change: { type: "reference", reference: output } });
		canonical({
			editor,
			change: {
				type: "job",
				job: { id: job.id, digest: job.digest, status: "ready", mediaId },
			},
		});
		if (job.replacement) {
			try {
				if (applyReplacement({ editor, job, mediaId }))
					notify("Clip replaced at its original duration");
			} catch {
				notifyWarning(
					"The replacement is in Media. The original clip was left in place.",
				);
			}
		} else if (job.seamless && !job.batchId) {
			try {
				if (insertSeamless({ editor, job, mediaId }))
					notify("Seamless Connect inserted on the timeline");
			} catch {
				notifyWarning(
					"The connection is in Media. Open The Director to insert it at the original cut.",
				);
			}
		} else
			notify(
				job.referenceImage
					? "Replacement reference image is ready"
					: job.kind === "storyboard"
						? "Director storyboard ready for review"
						: "Generated video added to Media",
			);
	} finally {
		imports.delete(key);
	}
}
