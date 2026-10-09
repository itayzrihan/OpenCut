/* eslint-disable opencut/prefer-object-params -- Account-scoped fixture helpers mirror the host IO calls. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	mkdtemp,
	mkdir,
	readFile,
	writeFile,
	readdir,
	stat,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import type { ProjectFontData } from "@/services/storage/types";

const account = new AsyncLocalStorage<string>();
let root: string;
let transition: typeof import("opencut-editor-runtime-wasm").sessionStoreTransition;
mock.module("opencut-editor-runtime-wasm", () => ({
	sessionStoreTransition: (...args: Parameters<typeof transition>) =>
		transition(...args),
}));
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: account.getStore()! }),
	accountDataRoot: () => join(root, account.getStore()!),
	accountsRoot: () => root,
	canImportLegacy: () => false,
}));
mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 1,
	mediaStorageDisposition: () => "copy",
	fullAutoEditStages: () => [],
	batchEditIsLocked: ({ status }: { status: string }) =>
		["queued", "ready", "running"].includes(status),
	batchEditTransition: () => "interrupted",
}));
const { operateEditorSession } = await import("../server/session-store");
const { withProjectWriteRequest } = await import("../server/project-write");
const {
	storeUploadedFont,
	putFontMetadata,
	deleteFont,
	clearFonts,
	listFonts,
	getFontFile,
} = await import("@/services/local-drive/server");
const { createProjectEdit } = await import("@/batch/server");

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-font-owner-"));
	const runtime = await createCanonicalTestRuntime();
	runtime.free();
	const glue =
		await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
	transition = glue.sessionStoreTransition;
	for (const owner of ["alice", "bob"])
		for (const id of ["legacy", "stream", "batch"]) {
			const directory = join(root, owner, "projects", id);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "project.json"),
				JSON.stringify({ metadata: { id, name: id, updatedAt: "saved" } }),
			);
		}
});
afterAll(async () => {
	const bounded = relative(tmpdir(), root);
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Unsafe cleanup");
	await rm(root, { recursive: true, force: true });
});
const metadata = (id: string): ProjectFontData => ({
	id,
	family: id,
	fileName: `${id}.woff2`,
	mimeType: "font/woff2",
	size: 8,
	lastModified: 1,
	createdAt: "2026-10-05T00:00:00.000Z",
});
const headers = (projectId: string, sessionId: string, generation: number) => ({
	"X-OpenCut-Editor-Project": projectId,
	"X-OpenCut-Editor-Session": sessionId,
	"X-OpenCut-Editor-Generation": String(generation),
});
const run = <T>(
	owner: string,
	authority: Record<string, string>,
	write: () => Promise<T>,
) =>
	account.run(owner, () =>
		withProjectWriteRequest({
			request: new Request("http://localhost/api/local-drive", {
				headers: authority,
			}),
			run: write,
		}),
	);
const acquire = (
	owner: string,
	projectId: string,
	sessionId: string,
	expectedGeneration: number,
) =>
	account.run(owner, () =>
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
const upload = (projectId: string, fontId: string, text: string) =>
	storeUploadedFont({
		projectId,
		fontId,
		fileName: `${fontId}.woff2`,
		body: new Blob([text]).stream(),
	});

test("font services preserve legacy imports but fence every adopted-project mutation by owner and account", async () => {
	const projectId = "legacy";
	const original = await run("alice", {}, () =>
		upload(projectId, "font", "original"),
	);
	await run("alice", {}, () =>
		putFontMetadata(projectId, metadata("font"), original),
	);
	await acquire("alice", projectId, "tab-a", 0);
	await acquire("bob", projectId, "tab-b", 0);
	const owner = headers(projectId, "tab-a", 1);
	for (const stale of [
		{},
		headers(projectId, "wrong-tab", 1),
		headers(projectId, "tab-a", 2),
	]) {
		for (const operation of [
			() => upload(projectId, "font", "replace"),
			() => putFontMetadata(projectId, metadata("font"), original),
			() => deleteFont(projectId, "font"),
			() => clearFonts(projectId),
		])
			await expect(run<unknown>("alice", stale, operation)).rejects.toThrow("ownership");
	}
	await expect(run("bob", owner, () => clearFonts(projectId))).rejects.toThrow(
		"ownership",
	);
	await expect(
		run("alice", headers("other", "tab-a", 1), () => clearFonts(projectId)),
	).rejects.toThrow("another project");
	expect(
		await readFile(
			join(root, "alice", "projects", projectId, original),
			"utf8",
		),
	).toBe("original");
	await Promise.all(
		["one", "two"].map(async (id) => {
			const path = await run("alice", owner, () => upload(projectId, id, id));
			await run("alice", owner, () =>
				putFontMetadata(projectId, metadata(id), path),
			);
		}),
	);
	expect(
		(await account.run("alice", () => listFonts(projectId)))
			.map((font) => font.id)
			.sort(),
	).toEqual(["font", "one", "two"]);
	await run("alice", owner, () => deleteFont(projectId, "one"));
	expect(
		await account.run("alice", () => getFontFile(projectId, "one")),
	).toBeNull();
	await run("alice", owner, () => clearFonts(projectId));
	expect(await account.run("alice", () => listFonts(projectId))).toEqual([]);
}, 20_000);

test("takeover during streamed upload remains responsive and rejects publication without replacing an existing font", async () => {
	const projectId = "stream";
	await acquire("alice", projectId, "uploader", 0);
	const originalOwner = headers(projectId, "uploader", 1);
	const original = await run("alice", originalOwner, () =>
		upload(projectId, "font", "original"),
	);
	await run("alice", originalOwner, () =>
		putFontMetadata(projectId, metadata("font"), original),
	);
	let finish!: () => void;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("partial"));
			finish = () => {
				controller.enqueue(new TextEncoder().encode(" finished"));
				controller.close();
			};
		},
	});
	const pending = run("alice", originalOwner, () =>
		storeUploadedFont({
			projectId,
			fontId: "font",
			fileName: "font.woff2",
			body,
		}),
	);
	void pending.catch(() => {});
	const staging = join(root, "alice", "staging/fonts");
	const deadline = Date.now() + 5_000;
	let staged = false;
	while (Date.now() < deadline) {
		const files = await readdir(staging);
		if (
			(await Promise.all(files.map((name) => stat(join(staging, name))))).some(
				(file) => file.size > 0,
			)
		) {
			staged = true;
			break;
		}
		await Bun.sleep(20);
	}
	expect(staged).toBe(true);
	// This would deadlock if the streamed body held either publication lock.
	await acquire("alice", projectId, "new-owner", 1);
	finish();
	await expect(pending).rejects.toThrow("ownership");
	expect(await readdir(staging)).toEqual([]);
	expect(
		await readFile(
			join(root, "alice", "projects", projectId, original),
			"utf8",
		),
	).toBe("original");
	expect(
		await readdir(join(root, "alice", "projects", projectId, "fonts/files")),
	).toHaveLength(1);
	await expect(
		run("alice", originalOwner, () =>
			putFontMetadata(projectId, metadata("font"), original),
		),
	).rejects.toThrow("ownership");
	const newOwner = headers(projectId, "new-owner", 2);
	const replacement = await run("alice", newOwner, () =>
		upload(projectId, "font", "new bytes"),
	);
	await run("alice", newOwner, () =>
		putFontMetadata(projectId, metadata("font"), replacement),
	);
	const file = await account.run("alice", () => getFontFile(projectId, "font"));
	expect(await readFile(file!.path, "utf8")).toBe("new bytes");
}, 20_000);

test("a background worker needs both the current batch token and editor generation", async () => {
	const projectId = "batch";
	await acquire("alice", projectId, "tab", 0);
	const { token } = await account.run("alice", () =>
		createProjectEdit({
			id: "job",
			projectId,
			expectedUpdatedAt: "saved",
			options: {
				zoom: false,
				transitions: false,
				wordAnimation: false,
				music: false,
			},
		}),
	);
	await expect(
		run("alice", headers(projectId, "tab", 1), () => clearFonts(projectId)),
	).rejects.toThrow("locked");
	await acquire("alice", projectId, "worker", 1);
	await expect(
		run("alice", { "X-OpenCut-Batch-Token": token }, () =>
			clearFonts(projectId),
		),
	).rejects.toThrow("ownership");
	await expect(
		run(
			"alice",
			{ ...headers(projectId, "tab", 1), "X-OpenCut-Batch-Token": token },
			() => clearFonts(projectId),
		),
	).rejects.toThrow("ownership");
	await run(
		"alice",
		{ ...headers(projectId, "worker", 2), "X-OpenCut-Batch-Token": token },
		() => clearFonts(projectId),
	);
});
