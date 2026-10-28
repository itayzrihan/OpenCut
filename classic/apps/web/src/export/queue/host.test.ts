import { test, expect, mock, afterAll } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
let releaseCanonical: (() => Promise<void>) | undefined;
const root = await mkdtemp(join(tmpdir(), "render-host-"));
const account = {
	id: "11111111-2222-4333-8444-555555555555",
	displayName: "Fixture",
	login: "fixture",
};
let count = 0,
	boot: any,
	child: any;
mock.module("@/accounts/server", () => ({
	accountDataRoot: () => root,
	requireAccount: () => account,
}));
mock.module("./server", () => ({
	readRenderQueue: async () => ({
		revision: 1,
		jobs: [{ status: "queued", delivery: "queue" }],
	}),
}));
mock.module("node:child_process", () => ({
	spawn: () => {
		count++;
		child = new EventEmitter();
		child.pid = process.pid;
		child.stdin = new EventEmitter();
		child.stdin.end = (value: string) => {
			boot = JSON.parse(value);
		};
		child.unref = () => {};
		child.kill = () => {};
		// Emit before any filesystem close callback: launch must register immediately.
		process.nextTick(async () => {
			releaseCanonical = await lockfile.lock(join(root, "render-queue"), {
				realpath: false,
			});
			child.emit("spawn");
		});
		return child;
	},
}));
const savedBinary = process.env.OPENCUT_RENDER_WORKER_ELECTRON,
	savedEntry = process.env.OPENCUT_RENDER_WORKER_APP;
process.env.OPENCUT_RENDER_WORKER_ELECTRON = process.execPath;
process.env.OPENCUT_RENDER_WORKER_APP = fileURLToPath(import.meta.url);
const { ensureRenderWorker } = await import("./host");
afterAll(async () => {
	mock.restore();
	if (savedBinary === undefined)
		delete process.env.OPENCUT_RENDER_WORKER_ELECTRON;
	else process.env.OPENCUT_RENDER_WORKER_ELECTRON = savedBinary;
	if (savedEntry === undefined) delete process.env.OPENCUT_RENDER_WORKER_APP;
	else process.env.OPENCUT_RENDER_WORKER_APP = savedEntry;
	await rm(root, { recursive: true, force: true });
});
test("one host process serves concurrent queue opens and survives viewer closure", async () => {
	const results = await Promise.all([
		ensureRenderWorker("http://localhost:3211"),
		ensureRenderWorker("http://localhost:3211"),
	]);
	expect(count).toBe(1);
	// Starting a renderer must not release or overwrite a simultaneous canonical queue lock.
	await releaseCanonical!();
	expect(results.every((r) => r?.status === "starting")).toBe(true);
	const lease = JSON.parse(
		await readFile(join(root, "render-queue/worker.json"), "utf8"),
	);
	expect(lease.tokenHash).toBe(
		createHash("sha256").update(boot.token).digest("hex"),
	);
	expect(lease.token).toBeUndefined();
	expect((await ensureRenderWorker("http://127.0.0.1:3211"))?.status).toBe(
		"running",
	);
	expect(count).toBe(1);
});
