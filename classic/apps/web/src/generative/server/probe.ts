import { mediaBinary } from "@/services/video-proxy/transcode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname } from "node:path";
import { file, json, saveJson } from "./store";
const execute = promisify(execFile);
/** Fixed metadata tool against a bounded uploaded artifact, never an arbitrary path. */
export async function probeReference({
	root,
	projectId,
	id,
}: {
	root: string;
	projectId: string;
	id: string;
}) {
	const reference = await file({ root, fileId: id, projectId });
	if (reference.info.kind === "image") return null;
	const durationSeconds = await probeStoredMediaDuration({
		path: reference.path,
	});
	const directory = dirname(reference.path),
		metadata = await json<Record<string, unknown>>({
			root: directory,
			name: basename(reference.path) + ".json",
		});
	await saveJson({
		root: directory,
		name: basename(reference.path) + ".json",
		value: { ...metadata, durationSeconds },
	});
	return durationSeconds;
}

/** Internal trusted staging/store path; never exposed as a request parameter. */
export async function probeStoredMediaDuration({ path }: { path: string }) {
	const { stdout } = await execute(
		mediaBinary("ffprobe"),
		["-v", "error", "-show_entries", "format=duration", "-of", "json", path],
		{ timeout: 30000, maxBuffer: 64 * 1024, windowsHide: true },
	).catch(() => {
		throw new Error(
			"Unable to verify original audio/video duration. Install ffprobe on the POCUT host and upload a playable media file.",
		);
	});
	const durationSeconds = Number(JSON.parse(stdout).format?.duration);
	if (
		!Number.isFinite(durationSeconds) ||
		durationSeconds <= 0 ||
		durationSeconds > 86400
	)
		throw new Error("Invalid reference duration");
	return durationSeconds;
}
