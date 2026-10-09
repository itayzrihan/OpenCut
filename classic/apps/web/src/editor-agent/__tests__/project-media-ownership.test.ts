/* eslint-disable opencut/prefer-object-params -- Isolated filesystem/account fixture helpers. */
import "../../../test-support/session-policy";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { accountScope } from "@/accounts/server";
import { operateEditorSession } from "../server/session-store";
import { withProjectWriteRequest } from "../server/project-write";

mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: ({ preserveLink }: { preserveLink: boolean }) =>
		preserveLink ? "link" : "copy",
	batchEditIsLocked: () => false,
	batchEditTransition: () => "",
	fullAutoEditStages: () => [],
}));
const {
	storeUploadedMedia,
	registerMediaPath,
	relinkMedia,
	putMediaMetadata,
	deleteMedia,
	clearMedia,
	beginMediaUpload,
	finishMediaUpload,
	listMedia,
	getMediaFile,
	putProject,
} = await import("@/services/local-drive/server");
let root: string;
const previousRoot = process.env.OPENCUT_ACCOUNTS_DIR;
const account = <T>(id: string, run: () => Promise<T>) =>
	accountScope.run({ id, login: id, displayName: id }, run);
const scope = (projectId: string, sessionId = "owner", generation = 1) => ({
	"X-OpenCut-Editor-Project": projectId,
	"X-OpenCut-Editor-Session": sessionId,
	"X-OpenCut-Editor-Generation": String(generation),
});
const run = <T>(
	headers: Record<string, string>,
	action: () => Promise<T>,
	owner = "alice",
) =>
	account(owner, () =>
		withProjectWriteRequest({
			request: new Request("http://localhost/api/local-drive", { headers }),
			run: action,
		}),
	);
const acquire = (
	projectId: string,
	sessionId: string,
	expectedGeneration: number,
	owner = "alice",
) =>
	account(owner, () =>
		operateEditorSession({
			projectId,
			request: {
				type: "acquire",
				sessionId,
				expectedGeneration,
				takeOver: true,
			},
		}),
	);
const upload = (
	projectId: string,
	id: string,
	text: string,
	uploadToken?: string,
) =>
	storeUploadedMedia({
		projectId,
		mediaId: id,
		fileName: "image.png",
		mimeType: "image/png",
		size: new TextEncoder().encode(text).length,
		lastModified: 1,
		body: new Blob([text]).stream(),
		allowLargeCopy: false,
		uploadToken,
	});
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-media-owner-"));
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	for (const owner of ["alice", "bob"])
		for (const id of ["operations", "takeover", "clear", "retry"])
			await account(owner, () =>
				putProject(id, { metadata: { id, name: id }, version: 33 }),
			);
});
afterAll(async () => {
	if (previousRoot === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
	else process.env.OPENCUT_ACCOUNTS_DIR = previousRoot;
	const bounded = relative(tmpdir(), root);
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Unsafe cleanup");
	await rm(root, { recursive: true, force: true });
});

test("every media mutation rejects a previous editor while the new owner can copy, link, edit and delete", async () => {
	const projectId = "operations";
	await acquire(projectId, "owner", 0);
	const headers = scope(projectId);
	const original = await run(headers, () =>
		upload(projectId, "original", "bytes"),
	);
	await run(headers, () => upload(projectId, "staged", "stage", "attempt"));
	await acquire(projectId, "next", 1);
	await acquire(projectId, "bob", 0, "bob");
	const replacement = join(root, "data/alice/replacement.png");
	await writeFile(replacement, "bytes");
	const draft = {
		kind: "hyperframes",
		name: "Example",
		sceneId: "scene",
		source: {
			entryFile: "index.html",
			files: {
				"index.html":
					"<div data-composition-id='main' data-duration='1'></div>",
			},
			resourceAssetIds: {},
		},
		resources: [],
	};
	let relinkCalls = 0;
	const relink = () =>
		relinkMedia(projectId, "original", replacement, 0, "relink", false, () => {
			relinkCalls++;
			throw new Error("Should not reach domain transaction");
		});
	const index = join(
		root,
		"data/alice/projects",
		projectId,
		"media/index.json",
	);
	const before = await readFile(index, "utf8");
	for (const action of [
		() => upload(projectId, "original", "overwrite"),
		() => putMediaMetadata(projectId, { ...original, name: "overwrite" }),
		() =>
			registerMediaPath({
				projectId,
				record: { ...original, sourcePath: replacement },
			}),
		() => beginMediaUpload(projectId, "new-attempt", draft),
		() => finishMediaUpload(projectId, "attempt", true),
		() => finishMediaUpload(projectId, "attempt", false),
		() => deleteMedia(projectId, "original"),
		() => clearMedia(projectId),
		relink,
	])
		await expect(run<unknown>(headers, action)).rejects.toThrow("ownership");
	expect(relinkCalls).toBe(0);
	await expect(run({}, () => clearMedia(projectId))).rejects.toThrow(
		"ownership",
	);
	await expect(
		run(headers, () => clearMedia(projectId), "bob"),
	).rejects.toThrow("ownership");
	expect(await readFile(index, "utf8")).toBe(before);
	expect(await readFile(original.sourcePath, "utf8")).toBe("bytes");
	const current = scope(projectId, "next", 2);
	await run(current, () => finishMediaUpload(projectId, "attempt", false));
	await run(current, () => finishMediaUpload(projectId, "attempt", true));
	expect(
		await account("alice", () => getMediaFile(projectId, "staged")),
	).not.toBeNull();
	const copied = await run(current, () =>
		registerMediaPath({
			projectId,
			record: {
				...original,
				id: "copy",
				name: "Copy",
				sourcePath: replacement,
			},
		}),
	);
	expect(copied.name).toBe("Copy");
	expect(copied.sourcePath).not.toBe(replacement);
	expect(await readFile(copied.sourcePath, "utf8")).toBe("bytes");
	const linked = await run(current, () =>
		registerMediaPath({
			projectId,
			record: { ...original, id: "linked", sourcePath: replacement },
			preserveLink: true,
		}),
	);
	expect(linked.storageKind).toBe("linked");
	await run(current, () =>
		putMediaMetadata(projectId, { ...copied, name: "Edited" }),
	);
	await run(current, () => deleteMedia(projectId, "copy"));
	expect(await readFile(copied.sourcePath, "utf8")).toBe("bytes"); // retained for Undo
	await run(current, () => clearMedia(projectId));
	expect(await account("alice", () => listMedia(projectId))).toEqual([]);
}, 20_000);

function pausedUpload(
	projectId: string,
	headers: Record<string, string>,
	uploadToken?: string,
) {
	let begin!: () => void;
	let finish!: () => void;
	const started = new Promise<void>((done) => {
		begin = done;
	});
	const released = new Promise<void>((done) => {
		finish = done;
	});
	const body = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				begin();
				await released;
				controller.enqueue(new TextEncoder().encode("old"));
				controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	const pending = run(headers, () =>
		storeUploadedMedia({
			projectId,
			mediaId: "target",
			fileName: "image.png",
			mimeType: "image/png",
			size: 3,
			lastModified: 1,
			allowLargeCopy: false,
			body,
			uploadToken,
		}),
	);
	void pending.catch(() => {});
	return { started, pending, finish };
}
test("takeover during media streaming rejects the old publication without changing existing bytes", async () => {
	const projectId = "takeover";
	await acquire(projectId, "owner", 0);
	const headers = scope(projectId);
	const original = await run(headers, () =>
		upload(projectId, "target", "original"),
	);
	const paused = pausedUpload(projectId, headers);
	try {
		await paused.started;
		await acquire(projectId, "next", 1);
	} finally {
		paused.finish();
	}
	await expect(paused.pending).rejects.toThrow("ownership");
	expect(await readFile(original.sourcePath, "utf8")).toBe("original");
	expect(await readdir(join(root, "data/alice/staging/media"))).toEqual([]);
}, 20_000);

test("clearing media invalidates an ordinary upload intent and prevents library resurrection", async () => {
	const projectId = "clear";
	await acquire(projectId, "owner", 0);
	const headers = scope(projectId);
	const paused = pausedUpload(projectId, headers);
	try {
		await paused.started;
		await run(headers, () => clearMedia(projectId));
	} finally {
		paused.finish();
	}
	await expect(paused.pending).rejects.toThrow("superseded or cleared");
	expect(await account("alice", () => listMedia(projectId))).toEqual([]);
	expect(await readdir(join(root, "data/alice/staging/media"))).toEqual([]);
}, 20_000);

test("a retry supersedes the old stream and its failure cannot remove the retry's committed file", async () => {
	const projectId = "retry";
	await acquire(projectId, "owner", 0);
	const headers = scope(projectId);
	const paused = pausedUpload(projectId, headers, "attempt");
	try {
		await paused.started;
		await run(headers, () => upload(projectId, "target", "new", "attempt"));
	} finally {
		paused.finish();
	}
	await expect(paused.pending).rejects.toThrow();
	const result = await account("alice", () =>
		getMediaFile(projectId, "target"),
	);
	expect(await readFile(result!.path, "utf8")).toBe("new");
	await run(headers, () => finishMediaUpload(projectId, "attempt", false));
	await run(headers, () => finishMediaUpload(projectId, "attempt", true));
	expect(await readFile(result!.path, "utf8")).toBe("new");
}, 20_000);
