/* eslint-disable opencut/prefer-object-params -- Isolated account and filesystem fixture helpers. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { accountScope } from "@/accounts/server";
const runtime = await createCanonicalTestRuntime();
runtime.free();
const glue =
	await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
mock.module("opencut-editor-runtime-wasm", () => ({
	sessionStoreTransition: glue.sessionStoreTransition,
	ownedProjectRead: glue.ownedProjectRead,
	ownedMediaTransferPlan: glue.ownedMediaTransferPlan,
}));
mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: ({ preserveLink }: { preserveLink: boolean }) =>
		preserveLink ? "link" : "copy",
	batchEditIsLocked: () => false,
	batchEditTransition: () => "",
	fullAutoEditStages: () => [],
}));
const { putProject, getProject, storeUploadedMedia, getMediaFile, listMedia } =
	await import("@/services/local-drive/server");
const { readOwnedProject, copyOwnedMedia } =
	await import("../server/owned-projects");
const { operateEditorSession } = await import("../server/session-store");
const { withProjectWriteRequest } = await import("../server/project-write");
let root: string;
const previousRoot = process.env.OPENCUT_ACCOUNTS_DIR;
const owner = <T>(id: string, run: () => Promise<T>) =>
	accountScope.run({ id, login: id, displayName: id }, run);
const read = (sourceProjectId = "source") =>
	owner("alice", () =>
		readOwnedProject({
			projectId: "target",
			request: {
				projectId: "target",
				expectedRevision: 2,
				sourceProjectId,
				limit: 1,
			},
		}),
	).then((value) =>
		z.object({ sourceFingerprint: z.string(), data: z.unknown() }).parse(value),
	);
const request = (fingerprint: string, operationId: string) => ({
	projectId: "target",
	expectedRevision: 2,
	sourceProjectId: "source",
	mediaId: "video-asset",
	operationId,
	sourceFingerprint: fingerprint,
});
const copy = (
	fingerprint: string,
	operationId: string,
	signal = new AbortController().signal,
) =>
	owner("alice", () =>
		copyOwnedMedia({
			projectId: "target",
			request: request(fingerprint, operationId),
			signal,
		}),
	);
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-owned-transfer-"));
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	const fixture = z
		.object({ document: z.record(z.string(), z.unknown()) })
		.parse(
			JSON.parse(
				await readFile(
					join(
						process.cwd(),
						"../../../crates/editor-api/tests/fixtures/classic-project.json",
					),
					"utf8",
				),
			),
		);
	for (const id of ["source", "target"])
		await owner("alice", () =>
			putProject(id, {
				...fixture.document,
				metadata: { id, name: id },
				credentials: "private project extension",
			}),
		);
	await owner("bob", () =>
		putProject("foreign", {
			...fixture.document,
			metadata: { id: "foreign", name: "foreign" },
		}),
	);
	const bytes = new TextEncoder().encode(
		"Owned video bytes for transfer identity tests",
	);
	await owner("alice", () =>
		storeUploadedMedia({
			projectId: "source",
			mediaId: "video-asset",
			fileName: "source.mp4",
			mimeType: "video/mp4",
			lastModified: 123,
			size: bytes.length,
			allowLargeCopy: false,
			body: new ReadableStream({
				start(c) {
					c.enqueue(bytes);
					c.close();
				},
			}),
		}),
	);
});
afterAll(async () => {
	if (previousRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
	else process.env.OPENCUT_ACCOUNTS_DIR = previousRoot;
	const bounded = relative(tmpdir(), root);
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Unsafe test cleanup");
	await rm(root, { recursive: true, force: true });
});
test("real Rust project projection scopes reads and omits private state and host paths", async () => {
	const result = await read();
	expect(JSON.stringify(result)).not.toContain("sourcePath");
	expect(JSON.stringify(result)).not.toContain("credentials");
	expect(JSON.stringify(result)).not.toContain(root);
	const clips = z
		.object({
			data: z.object({
				elements: z.array(
					z.object({
						element: z.object({ id: z.string(), duration: z.number() }),
					}),
				),
			}),
		})
		.parse(
			await owner("alice", () =>
				readOwnedProject({
					projectId: "target",
					request: {
						projectId: "target",
						expectedRevision: 2,
						sourceProjectId: "source",
						sceneId: "main-scene",
						offset: 1,
						limit: 1,
					},
				}),
			),
		);
	expect(clips.data.elements[0].element.id).toBe("item-2");
	expect(clips.data.elements[0].element.duration).toBe(1200000);
	await expect(read("foreign")).rejects.toThrow("owned");
	await expect(
		owner("bob", () =>
			readOwnedProject({
				projectId: "foreign",
				request: {
					projectId: "foreign",
					expectedRevision: 0,
					sourceProjectId: "source",
				},
			}),
		),
	).rejects.toThrow("owned");
});
test("copies exact owned bytes, retains source and recovers a lost reply with no second file", async () => {
	const fingerprint = (await read()).sourceFingerprint;
	const sourceBefore = await owner("alice", () => getProject("source"));
	const result = await copy(fingerprint, "copy-once");
	const id = z.string().parse(result.media.id);
	const file = await owner("alice", () => getMediaFile("target", id));
	expect(file).not.toBeNull();
	const bytes = await readFile(file!.path);
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(
		z.object({ sha256: z.string() }).parse(result.media.origin).sha256,
	);
	const files = await readdir(
		join(root, "data/alice/projects/target/media/files"),
	);
	const second = await copy(fingerprint, "copy-once");
	expect(second).toEqual(result);
	expect(
		await readdir(join(root, "data/alice/projects/target/media/files")),
	).toEqual(files);
	expect(await owner("alice", () => getProject("source"))).toEqual(
		sourceBefore,
	);
	expect(JSON.stringify(result)).not.toContain(root);
	// Completed target data is independent of later source edits.
	await owner("alice", () =>
		putProject("source", {
			...z.record(z.string(), z.unknown()).parse(sourceBefore),
			metadata: { id: "source", name: "Changed source" },
		}),
	);
	expect(await copy(fingerprint, "copy-once")).toEqual(result);
	const newer = (await read()).sourceFingerprint;
	await expect(copy(newer, "copy-once")).rejects.toThrow(
		"different copy content",
	);
	await expect(copy(fingerprint, "stale-source")).rejects.toThrow(
		"Saved source changed",
	);
});
test("pending durable intent recovers already-published bytes after restart", async () => {
	const fingerprint = (await read()).sourceFingerprint;
	const result = await copy(fingerprint, "restart");
	const directory = join(root, "data/alice/editor-agent/media-transfers");
	const names = await readdir(directory);
	const name = names.find((n) =>
		n.startsWith(z.string().parse(result.media.id).slice("transfer-".length)),
	)!;
	const path = join(directory, name);
	const saved = JSON.parse(await readFile(path, "utf8"));
	saved.state = "copying";
	await writeFile(path, JSON.stringify(saved));
	expect(await copy(fingerprint, "restart")).toEqual(result);
	expect(JSON.parse(await readFile(path, "utf8")).state).toBe("completed");
});
test("cancelled copy does not publish", async () => {
	const fingerprint = (await read()).sourceFingerprint;
	const controller = new AbortController();
	controller.abort();
	const before = await owner("alice", () => listMedia("target"));
	await expect(
		copy(fingerprint, "cancelled", controller.signal),
	).rejects.toThrow();
	expect(await owner("alice", () => listMedia("target"))).toEqual(before);
});
test("corrupt durable intent cannot redirect copying to another media identity", async () => {
	const fingerprint = (await read()).sourceFingerprint;
	const result = await copy(fingerprint, "corrupt-journal");
	const path = join(
		root,
		"data/alice/editor-agent/media-transfers",
		`${z.string().parse(result.media.id).slice("transfer-".length)}.json`,
	);
	const journal = JSON.parse(await readFile(path, "utf8"));
	journal.plan.reply.media.id = "victim";
	await writeFile(path, JSON.stringify(journal));
	const before = await owner("alice", () => listMedia("target"));
	await expect(copy(fingerprint, "corrupt-journal")).rejects.toThrow(
		"journal differs",
	);
	expect(await owner("alice", () => listMedia("target"))).toEqual(before);
});
test("an adopted target rejects writes without its current editor generation fence", async () => {
	const fingerprint = (await read()).sourceFingerprint;
	await owner("alice", () =>
		operateEditorSession({
			projectId: "target",
			request: {
				type: "acquire",
				sessionId: "owner",
				expectedGeneration: 0,
				takeOver: true,
			},
		}),
	);
	await expect(copy(fingerprint, "unfenced")).rejects.toThrow("ownership");
	const abort = new AbortController();
	abort.abort();
	await expect(
		owner("alice", () =>
			withProjectWriteRequest({
				request: new Request("http://localhost/copy", {
					signal: abort.signal,
					headers: {
						"X-OpenCut-Editor-Project": "target",
						"X-OpenCut-Editor-Session": "owner",
						"X-OpenCut-Editor-Generation": "1",
					},
				}),
				run: () =>
					copyOwnedMedia({
						projectId: "target",
						request: request(fingerprint, "aborted-publication"),
						signal: new AbortController().signal,
					}),
			}),
		),
	).rejects.toThrow();
});
