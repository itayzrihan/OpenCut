import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, writeFile } from "node:fs/promises";
import { join, isAbsolute, relative } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { accountDataRoot, requireAccount } from "@/accounts/server";
import { assertAccountMediaSource } from "@/accounts/media-source";
import {
	getProject,
	getMediaFile,
	listMedia,
	listProjectMetadata,
	storeUploadedMedia,
} from "@/services/local-drive/server";
import { createCancellationSafeFileStream } from "@/services/local-drive/file-stream";
import { withEditorProjectWrite } from "./project-write";

export class OwnedProjectRejected extends Error {}
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const readSchema = z
	.object({
		projectId: id,
		expectedRevision: z.number().int().nonnegative(),
		sourceProjectId: id.nullable().optional(),
		sceneId: id.nullable().optional(),
		offset: z.number().int().nonnegative().optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();
const transferSchema = z
	.object({
		projectId: id,
		expectedRevision: z.number().int().nonnegative(),
		sourceProjectId: id,
		mediaId: id,
		operationId: id,
		sourceFingerprint: digest,
	})
	.strict();
const replySchema = z
	.object({
		projectId: id,
		operationId: id,
		sourceProjectId: id,
		sourceMediaId: id,
		sourceFingerprint: digest,
		media: z.record(z.string(), z.unknown()),
	})
	.strict();
const planSchema = z
	.object({ key: digest, digest, reply: replySchema })
	.strict();
const journalSchema = z
	.object({
		version: z.literal(1),
		state: z.enum(["copying", "completed"]),
		plan: planSchema,
	})
	.strict();

async function owned({
	projectId,
	sourceProjectId,
}: {
	projectId: string;
	sourceProjectId?: string | null;
}) {
	requireAccount();
	const projects = await listProjectMetadata();
	if (
		!projects.some((p) => p.id === projectId) ||
		(sourceProjectId && !projects.some((p) => p.id === sourceProjectId))
	)
		throw new OwnedProjectRejected(
			"Source and target must be owned by the authenticated user",
		);
	const root = await realpath(join(accountDataRoot(), "projects"));
	for (const project of projects) {
		const projectId = id.parse(project.id);
		const directory = await realpath(join(root, projectId));
		const file = await realpath(join(directory, "project.json"));
		const within = ({ base, path }: { base: string; path: string }) => {
			const bounded = relative(base, path);
			return (
				bounded !== "" && !bounded.startsWith("..") && !isAbsolute(bounded)
			);
		};
		if (
			!within({ base: root, path: directory }) ||
			!within({ base: directory, path: file })
		)
			throw new OwnedProjectRejected(
				"Owned project storage points outside its account directory",
			);
	}
	return projects;
}
/** Filesystem IO only: the same compiled Rust projection serves the agent and UI. */
export async function readOwnedProject({
	projectId,
	request,
}: {
	projectId: string;
	request: unknown;
}) {
	const input = readSchema.parse(request);
	if (input.projectId !== projectId)
		throw new OwnedProjectRejected(
			"Owned read target differs from request scope",
		);
	const projects = await owned(input);
	const { ownedProjectRead } = await import("opencut-editor-runtime-wasm");
	try {
		if (!input.sourceProjectId) return ownedProjectRead(input, null, projects);
		const [project, media] = await Promise.all([
			getProject(input.sourceProjectId),
			listMedia(input.sourceProjectId),
		]);
		return ownedProjectRead(input, project, media);
	} catch (error) {
		throw new OwnedProjectRejected(String(error));
	}
}
async function checksum({
	path,
	signal,
}: {
	path: string;
	signal: AbortSignal;
}) {
	// Fixed chunks and an opened handle bound IO even when the source grows.
	const handle = await open(await assertAccountMediaSource(path), "r");
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size < 1 || before.size > 268_435_456)
			throw new OwnedProjectRejected("Copy supports files up to 256 MiB");
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(1024 * 1024);
		let used = 0;
		while (used < before.size) {
			signal.throwIfAborted();
			const result = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, before.size - used),
				used,
			);
			if (!result.bytesRead)
				throw new OwnedProjectRejected("Source file changed during read");
			used += result.bytesRead;
			hash.update(buffer.subarray(0, result.bytesRead));
		}
		const after = await handle.stat();
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new OwnedProjectRejected("Source file changed during read");
		signal.throwIfAborted();
		return { sha256: hash.digest("hex"), size: used };
	} finally {
		await handle.close();
	}
}
/** Copies owned bytes to a deterministic new media identity. Durable intent
 * precedes IO; a lost completion is recovered by hashing the existing target.
 * No network provider, raw model path or source-project write is involved. */
export async function copyOwnedMedia({
	projectId,
	request,
	signal,
}: {
	projectId: string;
	request: unknown;
	signal: AbortSignal;
}) {
	const input = transferSchema.parse(request);
	if (input.projectId !== projectId || input.sourceProjectId === projectId)
		throw new OwnedProjectRejected(
			"Copy requires distinct owned source and target projects",
		);
	await owned(input);
	signal.throwIfAborted();
	await withEditorProjectWrite({
		projectId,
		write: async ({ assertWrite }) => assertWrite(),
	});
	const { ownedMediaTransferPlan } =
		await import("opencut-editor-runtime-wasm");
	const directory = join(accountDataRoot(), "editor-agent", "media-transfers");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	// Rust owns the operation identity. A dummy media/byte fingerprint only
	// obtains the key and request digest before accessing any source bytes.
	let identity: z.infer<typeof planSchema>;
	try {
		identity = planSchema.parse(
			ownedMediaTransferPlan(
				input,
				{ id: input.mediaId, type: "video", fileName: "identity.mp4" },
				"0".repeat(64),
				1,
			),
		);
	} catch (error) {
		throw new OwnedProjectRejected(String(error));
	}
	let compromised = false;
	const release = await lockfile.lock(directory, {
		realpath: false,
		stale: 60_000,
		update: 10_000,
		retries: { retries: 40, minTimeout: 50, maxTimeout: 500 },
		onCompromised: () => {
			compromised = true;
		},
	});
	const assertCurrent = () => {
		signal.throwIfAborted();
		requireAccount();
		if (compromised)
			throw new Error("Copy lock lost; reconcile the same operationId");
	};
	try {
		const path = join(directory, `${identity.key}.json`);
		let journal: z.infer<typeof journalSchema> | null = null;
		try {
			const file = await open(path, "r");
			try {
				if ((await file.stat()).size > 64_000)
					throw new OwnedProjectRejected("Invalid transfer journal");
				journal = journalSchema.parse(JSON.parse(await file.readFile("utf8")));
			} finally {
				await file.close();
			}
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		assertCurrent();
		if (journal && journal.plan.digest !== identity.digest)
			throw new OwnedProjectRejected(
				"operationId belongs to different copy content",
			);
		if (!journal) {
			const source = z.object({ sourceFingerprint: digest }).parse(
				await readOwnedProject({
					projectId,
					request: {
						projectId,
						expectedRevision: input.expectedRevision,
						sourceProjectId: input.sourceProjectId,
						limit: 1,
					},
				}),
			);
			if (source.sourceFingerprint !== input.sourceFingerprint)
				throw new OwnedProjectRejected(
					"Saved source changed; read its fresh fingerprint before copying",
				);
			const sourceFile = await getMediaFile(
				input.sourceProjectId,
				input.mediaId,
			);
			if (!sourceFile)
				throw new OwnedProjectRejected(
					"Owned source media unavailable or compound",
				);
			const verified = await checksum({ path: sourceFile.path, signal });
			let plan: z.infer<typeof planSchema>;
			try {
				plan = planSchema.parse(
					ownedMediaTransferPlan(
						input,
						sourceFile.record,
						verified.sha256,
						verified.size,
					),
				);
			} catch (error) {
				throw new OwnedProjectRejected(String(error));
			}
			journal = { version: 1, state: "copying", plan };
			assertCurrent();
			await writeFile(path, JSON.stringify(journal), {
				flag: "wx",
				mode: 0o600,
			});
		}
		const media = journal.plan.reply.media;
		const targetId = id.parse(media.id),
			expectedSize = z.number().int().positive().parse(media.size);
		const expectedHash = digest.parse(
			z.object({ sha256: digest }).parse(media.origin).sha256,
		);
		// Validate recovered journals against the same policy before selecting a
		// target file or publishing anything. A corrupt journal cannot redirect IO.
		const validated = planSchema.parse(
			ownedMediaTransferPlan(
				input,
				{ ...media, id: input.mediaId },
				expectedHash,
				expectedSize,
			),
		);
		if (JSON.stringify(validated) !== JSON.stringify(journal.plan))
			throw new OwnedProjectRejected(
				"Transfer journal differs from its scoped copy policy",
			);
		const existing = await getMediaFile(projectId, targetId);
		if (existing) {
			const actual = await checksum({ path: existing.path, signal });
			if (actual.sha256 !== expectedHash || actual.size !== expectedSize)
				throw new OwnedProjectRejected(
					"Copied media identity has different bytes; existing media was preserved",
				);
		} else {
			if (journal.state === "completed")
				throw new OwnedProjectRejected(
					"Completed copied media was removed; it will not be recreated automatically",
				);
			const source = await getMediaFile(input.sourceProjectId, input.mediaId);
			if (!source)
				throw new OwnedProjectRejected(
					"Original source unavailable; copy remains recoverable with the same operationId",
				);
			const verified = await checksum({ path: source.path, signal });
			if (verified.sha256 !== expectedHash || verified.size !== expectedSize)
				throw new OwnedProjectRejected(
					"Original bytes changed; pending copy was not repeated",
				);
			assertCurrent();
			const hash = createHash("sha256");
			let copied = 0;
			const body = createCancellationSafeFileStream({
				path: await assertAccountMediaSource(source.path),
				start: 0,
				end: expectedSize - 1,
			}).pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						assertCurrent();
						copied += chunk.length;
						hash.update(chunk);
						controller.enqueue(chunk);
					},
					flush() {
						assertCurrent();
						if (copied !== expectedSize || hash.digest("hex") !== expectedHash)
							throw new OwnedProjectRejected(
								"Source bytes changed while copying; no target media was published",
							);
					},
				}),
				{ signal },
			);
			await storeUploadedMedia({
				projectId,
				mediaId: targetId,
				fileName: z.string().parse(media.fileName),
				mimeType: z.string().parse(media.mimeType),
				lastModified: z.number().parse(media.lastModified),
				size: expectedSize,
				allowLargeCopy: false,
				body,
				metadata: {
					...source.record,
					...media,
					id: targetId,
					sourcePath: "",
					storageKind: "copied",
				},
			});
		}
		assertCurrent();
		await owned(input);
		await withEditorProjectWrite({
			projectId,
			write: async ({ assertWrite }) => assertWrite(),
		});
		journal.state = "completed";
		const temporary = `${path}.${randomUUID()}.pending`;
		await writeFile(temporary, JSON.stringify(journal), {
			flag: "wx",
			mode: 0o600,
		});
		assertCurrent();
		await rename(temporary, path);
		return journal.plan.reply;
	} finally {
		await release();
	}
}
