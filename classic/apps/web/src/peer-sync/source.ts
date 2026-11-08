/** Project-owned source IO. Requests contain IDs and offsets, never paths. */
import { createHash, randomUUID } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";
import {
	getProject,
	getMediaFile,
	mimeTypeForPath,
} from "@/services/local-drive/server";
import { extname } from "node:path";
import { assertAccountMediaSource } from "@/accounts/media-source";
import type { PullManifest } from "./types";

export const CHUNK_BYTES = 256 * 1024;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const requestSchema = z.object({ projectId: id, mediaId: id }).strict();
const chunkSchema = z
	.object({
		grantId: z.string().uuid(),
		offset: z.number().int().nonnegative(),
		bytes: z.number().int().min(1).max(CHUNK_BYTES),
	})
	.strict();
type Version = { size: number; mtimeMs: number; ctimeMs: number; ino: number };
function same({ a, b }: { a: Version; b: Version }) {
	return (
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.ino === b.ino
	);
}
export async function checksumFile({
	path,
	signal,
}: {
	path: string;
	signal: AbortSignal;
}) {
	signal.throwIfAborted();
	const file = await open(path, "r");
	try {
		const before = await file.stat();
		if (!before.isFile()) throw new Error("Original is not a regular file");
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(1024 * 1024);
		let size = 0;
		for (;;) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
			size += bytesRead;
		}
		const after = await file.stat();
		signal.throwIfAborted();
		if (size !== before.size || !same({ a: before, b: after }))
			throw new Error("Original changed during verification");
		return { sha256: hash.digest("hex"), bytes: size, version: before };
	} finally {
		await file.close();
	}
}

export class PeerSource {
	constructor(
		private io: {
			project: (id: string) => Promise<unknown>;
			media: typeof getMediaFile;
			allow: typeof assertAccountMediaSource;
		} = {
			project: getProject,
			media: getMediaFile,
			allow: assertAccountMediaSource,
		},
	) {}
	private grants = new Map<
		string,
		{
			peer: string;
			projectId: string;
			mediaId: string;
			manifest: PullManifest;
			version: Version;
			expires: number;
		}
	>();
	async handle({
		peer,
		operation,
		data: raw,
		signal,
	}: {
		peer: string;
		operation: "manifest" | "chunk";
		data: unknown;
		signal: AbortSignal;
	}): Promise<unknown> {
		signal.throwIfAborted();
		for (const [key, grant] of this.grants)
			if (grant.expires <= Date.now()) this.grants.delete(key);
		if (operation === "manifest") {
			const input = requestSchema.parse(raw);
			if (!(await this.io.project(input.projectId)))
				throw new Error("Project is not owned by this account");
			const source = await this.io.media(input.projectId, input.mediaId);
			if (
				!source ||
				source.record.unifiedAngles ||
				source.record.size !== source.stat.size
			)
				throw new Error("Original unavailable or changed");
			if (
				source.record.storageKind === "linked" &&
				Number.isFinite(source.record.lastModified) &&
				Math.trunc(source.record.lastModified) !==
					Math.trunc(source.stat.mtimeMs)
			)
				throw new Error(
					"Linked original changed since it was registered; verify its binding first",
				);
			const verified = await checksumFile({
				path: await this.io.allow(source.path),
				signal,
			});
			const manifest: PullManifest = {
				...input,
				fileName: `original${extname(source.path).toLowerCase()}`,
				mimeType: source.record.mimeType || mimeTypeForPath(source.path),
				bytes: verified.bytes,
				sha256: verified.sha256,
				lastModified: Math.max(
					0,
					Math.trunc(
						Number.isFinite(source.record.lastModified)
							? source.record.lastModified
							: source.stat.mtimeMs,
					),
				),
			};
			if (this.grants.size >= 64)
				throw new Error("Too many original-file grants");
			const grantId = randomUUID();
			this.grants.set(grantId, {
				peer,
				...input,
				manifest,
				version: verified.version,
				expires: Date.now() + 300_000,
			});
			return { grantId, manifest };
		}
		const input = chunkSchema.parse(raw),
			grant = this.grants.get(input.grantId);
		if (
			!grant ||
			grant.peer !== peer ||
			input.offset + input.bytes > grant.manifest.bytes
		)
			throw new Error("Original-file grant expired or chunk is invalid");
		if (!(await this.io.project(grant.projectId)))
			throw new Error("Source project was removed");
		const source = await this.io.media(grant.projectId, grant.mediaId);
		if (!source || !same({ a: source.stat, b: grant.version }))
			throw new Error("Original source changed");
		let file: FileHandle | null = null;
		try {
			file = await open(await this.io.allow(source.path), "r");
			if (!same({ a: await file.stat(), b: grant.version }))
				throw new Error("Original source changed");
			const bytes = Buffer.alloc(input.bytes);
			const { bytesRead } = await file.read(
				bytes,
				0,
				bytes.length,
				input.offset,
			);
			signal.throwIfAborted();
			if (
				bytesRead !== input.bytes ||
				!same({ a: await file.stat(), b: grant.version })
			)
				throw new Error("Original source changed");
			grant.expires = Date.now() + 300_000;
			return { offset: input.offset, data: bytes.toString("base64") };
		} finally {
			await file?.close();
		}
	}
}
