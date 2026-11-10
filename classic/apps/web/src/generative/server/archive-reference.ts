import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	archiveReferenceDirectory,
	fileBytes,
	id,
	sha,
	validProject,
} from "./store";
import type { DirectorReference } from "../types";
import { probeStoredMediaDuration } from "./probe";

const descriptor = z
	.object({
		id: z.string().regex(/^[a-f0-9]{32}$/),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		name: z
			.string()
			.min(1)
			.max(300)
			.refine(
				(s) =>
					![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
			),
		mime: z.enum([
			"image/png",
			"image/jpeg",
			"image/webp",
			"audio/mpeg",
			"audio/wav",
			"audio/x-wav",
			"audio/mp4",
			"video/mp4",
			"video/quicktime",
			"video/webm",
		]),
		storyboard: z.boolean(),
	})
	.strict();

function fileError(error: unknown) {
	const parsed = z
		.object({ code: z.string().optional(), path: z.string().optional() })
		.safeParse(error);
	return parsed.success ? parsed.data : {};
}

function matchesMime({ bytes, mime }: { bytes: Buffer; mime: string }) {
	if (mime === "image/png")
		return bytes
			.subarray(0, 8)
			.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	if (mime === "image/jpeg")
		return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
	if (mime === "image/webp")
		return (
			bytes.toString("ascii", 0, 4) === "RIFF" &&
			bytes.toString("ascii", 8, 12) === "WEBP"
		);
	if (mime === "audio/wav" || mime === "audio/x-wav")
		return (
			bytes.toString("ascii", 0, 4) === "RIFF" &&
			bytes.toString("ascii", 8, 12) === "WAVE"
		);
	if (mime === "audio/mpeg")
		return (
			bytes.toString("ascii", 0, 3) === "ID3" ||
			(bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0)
		);
	if (mime === "video/webm")
		return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
	return bytes.toString("ascii", 4, 8) === "ftyp";
}

/** Imported files are inert bytes. No job, credential, provider request or source path is restored. */
export async function importArchiveReference({
	root,
	projectId,
	reference,
	bytes,
}: {
	root: string;
	projectId: string;
	reference: unknown;
	bytes: Buffer;
}): Promise<DirectorReference> {
	validProject(projectId);
	const input = descriptor.parse(reference);
	if (!bytes.length || bytes.length > 100 * 1024 * 1024)
		throw new Error("Archive reference exceeds100MB limit");
	if (sha(bytes) !== input.sha256)
		throw new Error("Archive reference checksum mismatch");
	if (!matchesMime({ bytes, mime: input.mime }))
		throw new Error("Archive reference content does not match its media type");
	const kind: DirectorReference["kind"] = input.mime.startsWith("image/")
		? "image"
		: input.mime.startsWith("audio/")
			? "audio"
			: "video";
	const result: DirectorReference = {
		id: input.id,
		name: input.name,
		mime: input.mime,
		kind,
		bytes: bytes.length,
		storyboard: input.storyboard,
	};
	const target = archiveReferenceDirectory({
		root,
		projectId,
		fileId: input.id,
	});
	const existing = async () => {
		const stored = await fileBytes({ root, projectId, fileId: input.id });
		if (
			stored.info.sha256 !== input.sha256 ||
			(["id", "name", "kind", "mime", "bytes", "storyboard"] as const).some(
				(key) => stored.info[key] !== result[key],
			)
		)
			throw new Error("Archive reference ID already contains different data");
		return result;
	};
	try {
		return await existing();
	} catch (error) {
		const failure = fileError(error);
		if (
			failure.code !== "ENOENT" ||
			failure.path !== join(target, "content.json")
		)
			throw error;
	}
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const staging = target + "." + id() + ".tmp";
	await mkdir(staging, { mode: 0o700 });
	try {
		await writeFile(join(staging, "content"), bytes, {
			mode: 0o600,
			flag: "wx",
		});
		const durationSeconds =
			kind === "image"
				? undefined
				: await probeStoredMediaDuration({ path: join(staging, "content") });
		await writeFile(
			join(staging, "content.json"),
			JSON.stringify({
				...result,
				projectId,
				sha256: input.sha256,
				durationSeconds,
			}),
			{ mode: 0o600, flag: "wx" },
		);
		try {
			await rename(staging, target);
		} catch (error) {
			if (
				!["EEXIST", "ENOTEMPTY", "EPERM"].includes(fileError(error).code ?? "")
			)
				throw error;
			return await existing();
		}
		return result;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
