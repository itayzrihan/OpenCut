import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import type { DirectorJob } from "./types";
import { fileUrl, canonical } from "./client";
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
}: {
	editor: EditorCore;
	projectId: string;
	accountId: string;
	job: DirectorJob;
	signal: AbortSignal;
	current: () => boolean;
	process: (input: { files: File[] }) => Promise<Omit<MediaAsset, "id">[]>;
	notify?: (message: string) => void;
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
	if (
		imports.has(key) ||
		editor.media.getAssets().some((a) => a.id === mediaId)
	)
		return;
	imports.add(key);
	try {
		const output = job.output;
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
		notify(
			job.kind === "storyboard"
				? "Director storyboard ready for review"
				: "Generated video added to Media",
		);
	} finally {
		imports.delete(key);
	}
}
