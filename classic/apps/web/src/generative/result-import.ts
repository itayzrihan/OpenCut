import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { DirectorJob } from "./types";
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
	if (!current()) return;
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
	if (job.status !== "ready" || !job.output || link?.mediaId) return;
	const mediaId = "generative-" + job.id,
		key = accountId + ":" + projectId + ":" + job.id;
	if (imports.has(key)) return;
	imports.add(key);
	try {
		const output = job.output;
		if (!editor.media.getAssets().some((a) => a.id === mediaId)) {
			const response = await fetch(fileUrl({ projectId, id: output.id }), {
				credentials: "same-origin",
				signal,
			});
			if (!response.ok) throw new Error("Generated media download failed");
			const file = new File([await response.blob()], output.name, {
				type: output.mime,
			});
			const assets = await process({ files: [file] });
			if (!current()) return;
			const asset = assets[0];
			if (!asset) throw new Error("Could not decode generated media");
			const imported = await editor.media.addMediaAsset({
				projectId,
				asset: { ...asset, id: mediaId },
			});
			if (!current()) return;
			if (!imported) throw new Error("Generated media import did not complete");
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
				notifyWarning("The replacement is in Media. The original clip was left in place.");
			}
		} else if (job.seamless) {
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
				job.referenceImage ? "Replacement reference image is ready"
				: job.kind === "storyboard"
					? "Director storyboard ready for review"
					: "Generated video added to Media",
			);
	} finally {
		imports.delete(key);
	}
}
