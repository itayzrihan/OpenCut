/** Bounded account-local binary host store. IDs only; no arbitrary paths. */
import { randomBytes, createHash } from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	rm,
	readdir,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DirectorReference, DirectorJob } from "../types";
export const id = () => randomBytes(16).toString("hex");
export const sha = (b: Buffer | string) =>
	createHash("sha256").update(b).digest("hex");
const pendingJsonWrites = new Map<string, Promise<void>>();
export function validId(value: string) {
	if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("Invalid artifact/job ID");
	return value;
}
export function validProject(value: string) {
	if (
		!value ||
		value.length > 256 ||
		[...value].some((c) => c.charCodeAt(0) < 32)
	)
		throw new Error("Invalid project");
	return value;
}
/** Portable copies keep their original reference IDs without changing source ownership. */
export function archiveReferenceDirectory({
	root,
	projectId,
	fileId,
}: {
	root: string;
	projectId: string;
	fileId: string;
}) {
	return join(
		root,
		"archive-files",
		sha(validProject(projectId)),
		validId(fileId),
	);
}
export async function saveJson({
	root,
	name,
	value,
}: {
	root: string;
	name: string;
	value: unknown;
}) {
	const target = join(root, name);
	const previous = pendingJsonWrites.get(target);
	const write = (async () => {
		await previous?.catch(() => {});
		await replaceJson({ root, target, value });
	})();
	pendingJsonWrites.set(target, write);
	try {
		await write;
	} finally {
		if (pendingJsonWrites.get(target) === write)
			pendingJsonWrites.delete(target);
	}
}

async function replaceJson({
	root,
	target,
	value,
}: {
	root: string;
	target: string;
	value: unknown;
}) {
	await mkdir(root, { recursive: true, mode: 0o700 });
	const tmp = join(root, `${id()}.tmp`);
	await writeFile(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				await rename(tmp, target);
				return;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (
					process.platform !== "win32" ||
					attempt === 5 ||
					(code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
				)
					throw error;
				// A concurrent Windows reader can briefly hold the destination open.
				await delay(10 * 2 ** attempt);
			}
		}
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}
export async function json<T>({
	root,
	name,
}: {
	root: string;
	name: string;
}): Promise<T> {
	const target = join(root, name);
	// Let queued writes finish before opening another Windows file handle.
	await pendingJsonWrites.get(target)?.catch(() => {});
	return JSON.parse(await readFile(target, "utf8"));
}
export function jobRoot({ root, jobId }: { root: string; jobId: string }) {
	return join(root, "jobs", validId(jobId));
}
export async function jobs({
	root,
	projectId,
}: {
	root: string;
	projectId: string;
}) {
	const folder = join(root, "jobs");
	const names = await readdir(folder).catch(() => []);
	const result: DirectorJob[] = [];
	for (const n of names) {
		if (!/^[a-f0-9]{32}$/.test(n)) continue;
		const j = await json<DirectorJob>({
			root: join(folder, n),
			name: "review.json",
		});
		if (j.projectId === projectId) result.push(j);
	}
	return result.sort((a, b) => b.createdAt - a.createdAt);
}
const TYPES: Record<string, DirectorReference["kind"]> = {
	"image/png": "image",
	"image/jpeg": "image",
	"image/webp": "image",
	"audio/mpeg": "audio",
	"audio/wav": "audio",
	"audio/mp4": "audio",
	"audio/x-wav": "audio",
	"video/mp4": "video",
	"video/quicktime": "video",
	"video/webm": "video",
};
export async function artifact({
	root,
	projectId,
	name,
	mime,
	bytes,
	storyboard = false,
}: {
	root: string;
	projectId: string;
	name: string;
	mime: string;
	bytes: Buffer;
	storyboard?: boolean;
}) {
	const kind = TYPES[mime];
	if (!kind || !bytes.length || bytes.length > 100 * 1024 * 1024)
		throw new Error(
			"Use supported PNG/JPEG/WebP, MP3/WAV/M4A or MP4/MOV/WebM up to100MB",
		);
	const directory = join(root, "files");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info: DirectorReference = {
		id: id(),
		name: name.slice(0, 300),
		kind,
		mime,
		bytes: bytes.length,
		storyboard,
	};
	await writeFile(join(directory, info.id), bytes, { mode: 0o600, flag: "wx" });
	await saveJson({
		root: directory,
		name: info.id + ".json",
		value: {
			...info,
			projectId,
			sha256: sha(bytes),
		},
	});
	return info;
}
export async function file({
	root,
	fileId,
	projectId,
}: {
	root: string;
	fileId: string;
	projectId: string;
}) {
	const directory = join(root, "files");
	validId(fileId);
	type Info = DirectorReference & {
		projectId: string;
		sha256: string;
		durationSeconds?: number;
	};
	let path = join(directory, fileId);
	let info = await json<Info>({
		root: directory,
		name: fileId + ".json",
	}).catch((error: unknown) => {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return null;
		throw error;
	});
	if (!info || info.projectId !== projectId) {
		const imported = archiveReferenceDirectory({ root, projectId, fileId });
		info = await json<Info>({ root: imported, name: "content.json" });
		path = join(imported, "content");
	}
	if (info.projectId !== projectId)
		throw new Error("Artifact belongs to another project");
	const meta = await stat(path);
	if (meta.size !== info.bytes || meta.size > 512 * 1024 * 1024)
		throw new Error("Artifact changed");
	return { info, path };
}
export async function fileBytes({
	root,
	fileId,
	projectId,
}: {
	root: string;
	fileId: string;
	projectId: string;
}) {
	const f = await file({ root: root, fileId: fileId, projectId: projectId });
	const bytes = await readFile(f.path);
	if (sha(bytes) !== f.info.sha256) throw new Error("Artifact hash changed");
	return { ...f, bytes };
}
