import { mediaBinary } from "@/services/video-proxy/transcode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { file, json, saveJson, validId } from "./store";
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
	const { stdout } = await execute(
		mediaBinary("ffprobe"),
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			reference.path,
		],
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
	const directory = join(root, "files"),
		metadata = await json<Record<string, unknown>>({
			root: directory,
			name: validId(id) + ".json",
		});
	await saveJson({
		root: directory,
		name: id + ".json",
		value: { ...metadata, durationSeconds },
	});
	return durationSeconds;
}
