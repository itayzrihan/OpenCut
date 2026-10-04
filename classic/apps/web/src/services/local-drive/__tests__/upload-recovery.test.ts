/* eslint-disable opencut/prefer-object-params -- Test helpers preserve Bun and filesystem signatures. */
import { spawn } from "node:child_process";
import {
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, mock, test as runTest } from "bun:test";
import { accountScope } from "@/accounts/server";

mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => 0,
	mediaStorageDisposition: () => "copy",
}));
const {
	storeUploadedMedia,
	finishMediaUpload,
	getMediaFile,
	listMedia,
	beginMediaUpload,
	readMediaUpload,
	listMediaUploads,
	putProject,
} = await import("../server");
const account = { id: "recovery-account", login: "test", displayName: "Test" };
const webRoot = fileURLToPath(new URL("../../../../", import.meta.url));

type Journal = {
	version: number;
	state: string;
	files: Array<{ mediaId: string; fileName: string; temporaryId: string }>;
};
const test = (name: string, body: (directory: string) => Promise<void>) =>
	runTest(
		name,
		async () => {
			const directory = await mkdtemp(
				join(tmpdir(), "opencut-upload-recovery-"),
			);
			const previous = process.env.OPENCUT_ACCOUNTS_DIR;
			process.env.OPENCUT_ACCOUNTS_DIR = directory;
			try {
				await accountScope.run(account, () => body(directory));
			} finally {
				if (previous === undefined) delete process.env.OPENCUT_ACCOUNTS_DIR;
				else process.env.OPENCUT_ACCOUNTS_DIR = previous;
				await rm(directory, { recursive: true, force: true });
			}
		},
		20_000,
	);

function root(directory: string) {
	return join(directory, "data", account.id, "projects", "project", "media");
}
function journalPath(directory: string, token: string) {
	return join(root(directory), "uploads", `${token}.json`);
}
async function journal(directory: string, token: string): Promise<Journal> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Reads only the journal created by this isolated fixture.
	return JSON.parse(
		await readFile(journalPath(directory, token), "utf8"),
	) as Journal;
}
function upload(
	mediaId: string,
	uploadToken?: string,
	body = new Blob(["bytes"]).stream(),
) {
	return storeUploadedMedia({
		projectId: "project",
		mediaId,
		fileName: "resource.bin",
		mimeType: "application/octet-stream",
		lastModified: 1,
		size: 5,
		allowLargeCopy: false,
		uploadToken,
		body,
	});
}

function draft(ids = ["one", "two"]) {
	return {
		kind: "hyperframes",
		name: "Recover me",
		sceneId: "scene",
		startSeconds: 3,
		source: {
			entryFile: "index.html",
			files: {
				"index.html":
					"<div data-composition-id='test' data-duration='1'></div>",
			},
			resourceAssetIds: Object.fromEntries(ids.map((id) => [`${id}.bin`, id])),
		},
		resources: ids.map((id) => ({
			id,
			name: `${id}.bin`,
			fileName: "resource.bin",
			mimeType: "application/octet-stream",
			type: "file",
			size: 5,
			lastModified: 1,
		})),
	};
}

test("pending plans survive reload, count complete files and cannot be changed or reopened", async (directory) => {
	await putProject("project", {
		metadata: { id: "project", name: "Project" },
		version: 33,
	});
	const plan = draft();
	await beginMediaUpload("project", "resumable", plan);
	await beginMediaUpload("project", "resumable", plan);
	expect(await listMediaUploads("project")).toMatchObject([
		{ uploadToken: "resumable", name: "Recover me", completed: 0, total: 2 },
	]);
	await upload("one", "resumable");
	expect((await readMediaUpload("project", "resumable")).readyAssetIds).toEqual(
		["one"],
	);
	expect((await readMediaUpload("project", "resumable")).draft).toEqual(plan);
	await expect(
		beginMediaUpload("project", "resumable", { ...plan, startSeconds: 4 }),
	).rejects.toThrow("does not match");
	await accountScope.run({ ...account, id: "other-account" }, async () =>
		expect(await listMediaUploads("project")).toEqual([]),
	);
	await finishMediaUpload("project", "resumable", false);
	expect(await listMediaUploads("project")).toEqual([]);
	expect(
		await readFile(journalPath(directory, "resumable"), "utf8"),
	).not.toContain("Recover me");
	await expect(beginMediaUpload("project", "resumable", plan)).rejects.toThrow(
		"closed",
	);
});

test("a new process resumes an unindexed partial file using the original attempt", async (directory) => {
	await putProject("project", {
		metadata: { id: "project", name: "Project" },
		version: 33,
	});
	const plan = draft(["interrupted"]);
	plan.resources[0].size = 6;
	await beginMediaUpload("project", "crashed-attempt", plan);
	const { temporaryPath, destination } = await crashDuringUpload(directory);
	await rename(temporaryPath, destination);
	expect(
		(await readMediaUpload("project", "crashed-attempt")).readyAssetIds,
	).toEqual([]);
	await storeUploadedMedia({
		projectId: "project",
		mediaId: "interrupted",
		fileName: "resource.bin",
		mimeType: "application/octet-stream",
		lastModified: 1,
		size: 6,
		allowLargeCopy: false,
		uploadToken: "crashed-attempt",
		body: new Blob(["finish"]).stream(),
	});
	expect(
		(await readMediaUpload("project", "crashed-attempt")).readyAssetIds,
	).toEqual(["interrupted"]);
	expect(await readFile(destination, "utf8")).toBe("finish");
	expect(await stat(temporaryPath).catch(() => null)).toBeNull();
});

test("missing or truncated files remain incomplete and metadata cannot name external paths", async () => {
	await putProject("project", {
		metadata: { id: "project", name: "Project" },
		version: 33,
	});
	await beginMediaUpload("project", "resumable", draft());
	await upload("one", "resumable");
	const file = (await getMediaFile("project", "one"))!;
	await writeFile(file.path, "shorter than expected");
	expect((await readMediaUpload("project", "resumable")).readyAssetIds).toEqual(
		[],
	);
	const invalid = draft();
	Object.assign(invalid.resources[0], { sourcePath: "C:/private" });
	await expect(
		beginMediaUpload("project", "invalid", invalid),
	).rejects.toThrow();
	expect(await listMediaUploads("project")).toHaveLength(1);
});

async function crashDuringUpload(directory: string) {
	const worker = spawn(
		process.execPath,
		["run", "test-support/upload-crash-worker.ts"],
		{
			cwd: webRoot,
			env: { ...process.env, OPENCUT_ACCOUNTS_DIR: directory },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		},
	);
	const exited = new Promise<void>((resolve) =>
		worker.once("exit", () => resolve()),
	);
	let output = "";
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Worker did not start: ${output}`)),
				8000,
			);
			worker.once("error", reject);
			worker.once("exit", (code) => {
				clearTimeout(timeout);
				reject(new Error(`Worker exited ${code}: ${output}`));
			});
			worker.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			worker.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				if (output.includes("upload-stream-open")) {
					clearTimeout(timeout);
					resolve();
				}
			});
		});
		const saved = await journal(directory, "crashed-attempt");
		expect(saved.state).toBe("open");
		expect(saved.files).toHaveLength(1);
		const file = saved.files[0];
		const destination = join(
			root(directory),
			"files",
			`${file.mediaId}--crashed-attempt--${file.fileName}`,
		);
		const temporaryPath = `${destination}.${file.temporaryId}.tmp`;
		for (let tries = 0; tries < 100; tries++) {
			if ((await stat(temporaryPath).catch(() => null))?.size === 4) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect((await stat(temporaryPath)).size).toBe(4);
		return { destination, temporaryPath };
	} finally {
		worker.kill("SIGKILL");
		await exited;
	}
}

for (const phase of ["during copy", "after rename before indexing"]) {
	test(`replays a discard after a server crash ${phase}`, async (directory) => {
		await upload("ordinary");
		const ordinary = (await getMediaFile("project", "ordinary"))!;
		const { destination, temporaryPath } = await crashDuringUpload(directory);
		if (phase === "after rename before indexing")
			await rename(temporaryPath, destination);
		expect((await listMedia("project")).map((record) => record.id)).toEqual([
			"ordinary",
		]);
		await finishMediaUpload("project", "crashed-attempt", true);
		expect(await stat(temporaryPath).catch(() => null)).toBeNull();
		expect(await stat(destination).catch(() => null)).toBeNull();
		expect(await readFile(ordinary.path, "utf8")).toBe("bytes");
		expect((await journal(directory, "crashed-attempt")).state).toBe(
			"discarded",
		);
		await finishMediaUpload("project", "crashed-attempt", true);
		await expect(upload("late", "crashed-attempt")).rejects.toThrow(
			"already closed",
		);
	});
}

test("discard waits for an active copy and rejects a delayed upload after closure", async (directory) => {
	let copied!: () => void;
	const started = new Promise<void>((resolve) => {
		copied = resolve;
	});
	let resume!: () => void;
	const release = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const saving = upload(
		"in-flight",
		"attempt",
		new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					copied();
					await release;
					controller.enqueue(new TextEncoder().encode("bytes"));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		),
	);
	await started;
	const discard = finishMediaUpload("project", "attempt", true);
	resume();
	await Promise.all([saving, discard]);
	expect(await listMedia("project")).toEqual([]);
	expect(await readdir(join(root(directory), "files"))).toEqual([]);
	await expect(upload("too-late", "attempt")).rejects.toThrow("already closed");
});

test("retention intent survives a crash before index ownership is cleared", async (directory) => {
	await upload("saved", "attempt");
	const bytes = (await getMediaFile("project", "saved"))!.path;
	const saved = await journal(directory, "attempt");
	saved.state = "retained";
	await writeFile(journalPath(directory, "attempt"), JSON.stringify(saved));
	await finishMediaUpload("project", "attempt", true);
	expect(await readFile(bytes, "utf8")).toBe("bytes");
	expect(
		await readFile(join(root(directory), "index.json"), "utf8"),
	).not.toContain("uploadToken");
	await expect(upload("late", "attempt")).rejects.toThrow("already closed");
});

test("a waiting upload does not block another attempt or lose its index record", async () => {
	let copied!: () => void;
	const started = new Promise<void>((resolve) => {
		copied = resolve;
	});
	let resume!: () => void;
	const release = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const waiting = upload(
		"slow",
		"slow-attempt",
		new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					copied();
					await release;
					controller.enqueue(new TextEncoder().encode("bytes"));
					controller.close();
				},
			},
			{ highWaterMark: 0 },
		),
	);
	try {
		await started;
		await upload("fast", "fast-attempt");
		await finishMediaUpload("project", "fast-attempt", false);
		expect((await listMedia("project")).map((record) => record.id)).toEqual([
			"fast",
		]);
	} finally {
		resume();
		await waiting;
	}
	expect(
		(await listMedia("project")).map((record) => record.id).sort(),
	).toEqual(["fast", "slow"]);
});

test("concurrent attempts cannot replace the same ID or discard the winner's bytes", async () => {
	const tokens = ["first", "later"];
	const results = await Promise.allSettled(
		tokens.map((token) =>
			upload("shared-id", token, new Blob([token]).stream()),
		),
	);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	const winner = results.findIndex((result) => result.status === "fulfilled");
	const loser = 1 - winner;
	const file = (await getMediaFile("project", "shared-id"))!;
	await finishMediaUpload("project", tokens[loser], true);
	expect(await readFile(file.path, "utf8")).toBe(tokens[winner]);
	await finishMediaUpload("project", tokens[winner], false);
	await finishMediaUpload("project", tokens[winner], true);
	expect(await readFile(file.path, "utf8")).toBe(tokens[winner]);
});

test("legacy uploads without a journal still finalize and discard by index ownership", async (directory) => {
	await upload("legacy", "old-attempt");
	const file = (await getMediaFile("project", "legacy"))!;
	await rm(journalPath(directory, "old-attempt"));
	await finishMediaUpload("project", "old-attempt", true);
	expect(await stat(file.path).catch(() => null)).toBeNull();
	expect(await listMedia("project")).toEqual([]);
});

test("discard intent resumes after bytes were removed but the index was not saved", async (directory) => {
	await upload("staged", "attempt");
	const bytes = (await getMediaFile("project", "staged"))!.path;
	const saved = await journal(directory, "attempt");
	saved.state = "discarding";
	await writeFile(journalPath(directory, "attempt"), JSON.stringify(saved));
	await rm(bytes);
	await expect(finishMediaUpload("project", "attempt", false)).rejects.toThrow(
		"being discarded",
	);
	await finishMediaUpload("project", "attempt", true);
	expect(await listMedia("project")).toEqual([]);
	expect((await journal(directory, "attempt")).files).toEqual([]);
});

test("journal cleanup is account scoped and rejects invalid filenames before deleting any file", async (directory) => {
	await upload("staged", "attempt");
	const bytes = (await getMediaFile("project", "staged"))!.path;
	await accountScope.run({ ...account, id: "other-account" }, () =>
		finishMediaUpload("project", "attempt", true),
	);
	expect(await readFile(bytes, "utf8")).toBe("bytes");
	const saved = await journal(directory, "attempt");
	saved.files.push({
		mediaId: "escape",
		fileName: "../../outside",
		temporaryId: "temp",
	});
	await writeFile(journalPath(directory, "attempt"), JSON.stringify(saved));
	await expect(finishMediaUpload("project", "attempt", true)).rejects.toThrow(
		"Invalid upload journal filename",
	);
	expect(await readFile(bytes, "utf8")).toBe("bytes");
	expect((await listMedia("project")).map((record) => record.id)).toEqual([
		"staged",
	]);
});
