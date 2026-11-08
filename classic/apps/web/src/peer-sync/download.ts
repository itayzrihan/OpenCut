/** Stages bytes without touching timeline state or replacing an existing source.
 * Publication is a later, fenced canonical relink using the same media ID. */
import {
	mkdir,
	open,
	readFile,
	rename,
	stat,
	statfs,
	link,
	unlink,
	utimes,
	lstat,
	realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";
import { extname } from "node:path";
import { z } from "zod";
import { checksumFile, CHUNK_BYTES } from "./source";
import type { PullJob, PullManifest, PullRequest } from "./types";

export const pullRequestSchema = z
	.object({
		projectId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		mediaId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		operationId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
		expectedBindingRevision: z.number().int().nonnegative().max(0xfffffffe),
	})
	.strict();
const manifestSchema = z
	.object({
		projectId: z.string().max(160),
		mediaId: z.string().max(160),
		fileName: z.string().max(256),
		mimeType: z.string().max(160),
		bytes: z
			.number()
			.int()
			.positive()
			.max(8 * 1024 ** 4),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
const journalSchema = z
	.object({
		request: pullRequestSchema,
		manifest: manifestSchema.nullable(),
		job: z.record(z.string(), z.unknown()),
	})
	.strict();
function originalPath({
	directory,
	manifest,
}: {
	directory: string;
	manifest: PullManifest;
}) {
	const extension = extname(manifest.fileName).toLowerCase();
	if (
		!/^\.(mp4|mov|mkv|webm|avi|m4v|mp3|wav|aac|flac|ogg|m4a|png|jpe?g|gif|webp|svg|bmp|avif)$/.test(
			extension,
		)
	)
		throw new Error("Unsupported original media extension");
	return join(directory, `verified-original${extension}`);
}
export type RequestPeerInput = {
	operation: "manifest" | "chunk";
	data: unknown;
	signal: AbortSignal;
	timeoutMs?: number;
};
type RequestPeer = (request: RequestPeerInput) => Promise<unknown>;
export function transferDirectory({
	root,
	input,
}: {
	root: string;
	input: PullRequest;
}) {
	pullRequestSchema.parse(input);
	return join(root, input.projectId, input.operationId);
}
async function save({
	directory,
	input,
	manifest,
	job,
}: {
	directory: string;
	input: PullRequest;
	manifest: PullManifest | null;
	job: PullJob;
}) {
	const path = join(directory, "journal.json"),
		temporary = `${path}.${randomUUID()}.tmp`;
	await open(temporary, "wx", 0o600).then(async (file) => {
		try {
			await file.writeFile(JSON.stringify({ request: input, manifest, job }));
			await file.sync();
		} finally {
			await file.close();
		}
	});
	await rename(temporary, path);
}
export async function readPullJournal({
	root,
	input,
}: {
	root: string;
	input: PullRequest;
}) {
	const directory = transferDirectory({ root, input });
	try {
		const path = join(directory, "journal.json");
		if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
			throw new Error("Transfer journal must be a regular file");
		if ((await stat(path)).size > 64_000)
			throw new Error("Transfer journal exceeded its bound");
		const value = journalSchema.parse(JSON.parse(await readFile(path, "utf8")));
		if (JSON.stringify(value.request) !== JSON.stringify(input))
			throw new Error("operationId belongs to a different transfer");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
export async function downloadOriginal({
	root,
	input: rawInput,
	localRecord,
	requestPeer,
	validate,
	signal,
	job,
}: {
	root: string;
	input: PullRequest;
	localRecord: Record<string, unknown>;
	requestPeer: RequestPeer;
	validate: (
		request: PullRequest,
		manifest: PullManifest,
		local: Record<string, unknown>,
	) => void;
	signal: AbortSignal;
	job: PullJob;
}) {
	const input = pullRequestSchema.parse(rawInput),
		directory = transferDirectory({ root, input });
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const relativePath = relative(
		await realpath(root),
		await realpath(directory),
	);
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	)
		throw new Error("Transfer directory left its account scope");
	let manifest: PullManifest | null = null;
	const persist = () => {
		job.updatedAt = Date.now();
		return save({ directory, input, manifest, job });
	};
	// A mismatched operation may never replace another operation's journal,
	// including through error reporting in the catch block.
	const previous = await readPullJournal({ root, input });
	try {
		if (previous?.job.status === "ready") {
			manifest = previous.manifest;
			if (!manifest) throw new Error("Ready transfer has no verified original");
			validate(input, manifest, localRecord);
			const target = originalPath({ directory, manifest });
			const verified = await checksumFile({ path: target, signal });
			if (
				verified.bytes !== manifest.bytes ||
				verified.sha256 !== manifest.sha256
			)
				throw new Error("Previously verified original was changed");
			Object.assign(job, {
				status: "ready",
				phase: "ready",
				receivedBytes: manifest.bytes,
				totalBytes: manifest.bytes,
				source: target,
				manifest,
				sourceVersion: await stat(target),
			});
			return;
		}
		manifest = previous?.manifest ?? null;
		await persist();
		const source = z
			.object({ grantId: z.string().uuid(), manifest: manifestSchema })
			.strict()
			.parse(
				await requestPeer({
					operation: "manifest",
					data: { projectId: input.projectId, mediaId: input.mediaId },
					signal,
					timeoutMs: 600_000,
				}),
			);
		const candidate = source.manifest;
		validate(input, candidate, localRecord);
		if (
			previous?.manifest &&
			JSON.stringify(previous.manifest) !== JSON.stringify(candidate)
		)
			throw new Error(
				"Source changed since this download began; start a new operation",
			);
		manifest = candidate;
		signal.throwIfAborted();
		const partial = join(directory, "original.partial"),
			target = originalPath({ directory, manifest });
		for (const path of [partial, target, join(directory, "journal.json")]) {
			const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (entry && (!entry.isFile() || entry.isSymbolicLink()))
				throw new Error("Transfer files must be regular account-owned files");
		}
		if (
			(
				await stat(target).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return null;
					throw error;
				})
			)?.isFile()
		) {
			const verified = await checksumFile({ path: target, signal });
			if (
				verified.bytes !== manifest.bytes ||
				verified.sha256 !== manifest.sha256
			)
				throw new Error(
					"Existing downloaded original has different bytes; preserved it",
				);
			const facts = await stat(target);
			Object.assign(job, {
				source: target,
				manifest,
				sourceVersion: {
					size: facts.size,
					mtimeMs: facts.mtimeMs,
					ctimeMs: facts.ctimeMs,
					ino: facts.ino,
				},
				status: "ready",
				phase: "ready",
				receivedBytes: manifest.bytes,
				totalBytes: manifest.bytes,
			});
			await persist();
			return;
		}
		let file;
		try {
			file = await open(partial, "wx+", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			file = await open(partial, "r+");
		}
		try {
			let position = (await file.stat()).size;
			if (position > manifest.bytes)
				throw new Error("Partial original is longer than its manifest");
			const free = await statfs(directory);
			if (
				free.bavail * free.bsize <
				manifest.bytes - position + 256 * 1024 * 1024
			)
				throw new Error("Not enough free space to pull this original");
			Object.assign(job, {
				phase: "downloading",
				receivedBytes: position,
				totalBytes: manifest.bytes,
				manifest,
			});
			await persist();
			let savedAt = position;
			while (position < manifest.bytes) {
				signal.throwIfAborted();
				const count = Math.min(CHUNK_BYTES, manifest.bytes - position);
				const chunk = z
					.object({
						offset: z.number().int().nonnegative(),
						data: z
							.string()
							.max(350_000)
							.regex(/^[A-Za-z0-9+/]*={0,2}$/),
					})
					.strict()
					.parse(
						await requestPeer({
							operation: "chunk",
							data: { grantId: source.grantId, offset: position, bytes: count },
							signal,
						}),
					);
				const data = Buffer.from(chunk.data, "base64");
				if (chunk.offset !== position || data.length !== count)
					throw new Error("Source returned a different chunk range");
				signal.throwIfAborted();
				let written = 0;
				while (written < data.length) {
					const { bytesWritten } = await file.write(
						data,
						written,
						data.length - written,
						position + written,
					);
					if (!bytesWritten)
						throw new Error("Could not write original-file chunk");
					written += bytesWritten;
				}
				position += data.length;
				job.receivedBytes = position;
				if (position - savedAt >= 4 * 1024 * 1024) {
					await file.sync();
					await persist();
					savedAt = position;
				}
			}
			await file.sync();
		} finally {
			await file.close();
		}
		job.phase = "verifying";
		await persist();
		const verified = await checksumFile({ path: partial, signal });
		if (
			verified.bytes !== manifest.bytes ||
			verified.sha256 !== manifest.sha256
		) {
			await rename(
				partial,
				join(directory, `rejected-${randomUUID()}.partial`),
			);
			throw new Error(
				"Original checksum differs; unverified bytes were retained and were not linked",
			);
		}
		signal.throwIfAborted();
		// Hard-link publication refuses to overwrite an existing file, including
		// after a lost reply. The journal is not accepted as proof of file bytes.
		try {
			await link(partial, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await checksumFile({ path: target, signal });
			if (
				existing.bytes !== manifest.bytes ||
				existing.sha256 !== manifest.sha256
			)
				throw new Error(
					"Existing downloaded original has different bytes; preserved it",
				);
		}
		await unlink(partial);
		await utimes(target, new Date(), new Date(manifest.lastModified));
		signal.throwIfAborted();
		const facts = await stat(target);
		Object.assign(job, {
			source: target,
			sourceVersion: {
				size: facts.size,
				mtimeMs: facts.mtimeMs,
				ctimeMs: facts.ctimeMs,
				ino: facts.ino,
			},
			status: "ready",
			phase: "ready",
			receivedBytes: manifest.bytes,
			totalBytes: manifest.bytes,
		});
		await persist();
	} catch (error) {
		job.status = signal.aborted ? "cancelled" : "failed";
		job.error = (error instanceof Error ? error.message : String(error)).slice(
			0,
			1000,
		);
		await persist();
		throw error;
	}
}
