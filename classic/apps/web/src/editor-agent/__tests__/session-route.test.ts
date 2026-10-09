import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

const root = await mkdtemp(join(tmpdir(), "opencut-session-route-"));
mock.module("@/accounts/server", () => ({
	withAccount: (handler: (request: Request) => Promise<Response>) => handler,
}));
mock.module("@/services/local-drive/server", () => ({
	getLocalDriveStatus: async () => ({ rootPath: root }),
	getProject: async () => null,
}));
mock.module("opencut-wasm", () => ({
	fullAutoEditStages: () => [],
	batchEditIsLocked: ({ status }: { status: string }) => status === "queued",
	batchEditTransition: () => "interrupted",
}));
class SessionRejected extends Error {}
let effectCalls = 0;
let mode: "ok" | "io" | "policy" = "ok";
mock.module("@/editor-agent/server/session-store", () => ({
	SessionRejected,
	operateEditorSession: async ({
		assertHostLock,
	}: {
		assertHostLock?: () => void;
	}) => {
		assertHostLock?.();
		effectCalls++;
		if (mode === "io") throw new Error("Lost storage acknowledgement");
		if (mode === "policy") throw new SessionRejected("Ownership transferred");
		return { accepted: true };
	},
}));
const { createBatch } = await import("@/batch/server");
const { POST } = await import("@/app/api/editor-session/route");
const submit = (token?: string) =>
	POST(
		new Request("http://localhost/api/editor-session", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { "X-OpenCut-Batch-Token": token } : {}),
			},
			body: JSON.stringify({
				projectId: "project",
				request: { type: "acquire" },
			}),
		}),
	);
afterAll(async () => {
	const bounded = relative(tmpdir(), root);
	if (!bounded || bounded.startsWith("..") || isAbsolute(bounded))
		throw new Error("Unsafe cleanup");
	await rm(root, { recursive: true, force: true });
});

test("batch pre-write rejection is definitive, but storage uncertainty remains retryable", async () => {
	const { token } = await createBatch({
		id: "run",
		files: [{ projectId: "project", fileName: "video.mp4" }],
		options: {
			zoom: false,
			transitions: false,
			wordAnimation: false,
			music: false,
		},
	});
	for (const supplied of [undefined, "expired-token"]) {
		const response = await submit(supplied);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ definitive: true });
	}
	expect(effectCalls).toBe(0);
	mode = "io";
	const uncertain = await submit(token);
	expect(uncertain.status).toBe(503);
	expect(await uncertain.json()).toMatchObject({ definitive: false });
	mode = "policy";
	const rejected = await submit(token);
	expect(rejected.status).toBe(409);
	expect(await rejected.json()).toMatchObject({ definitive: true });
	mode = "ok";
	expect((await submit(token)).status).toBe(200);
	expect(effectCalls).toBe(3);
});
