import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, mkdir, copyFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

const account = new AsyncLocalStorage<string>();
let root: string;
let dispatch: typeof import("opencut-editor-runtime-wasm").knowledgeDispatch;
mock.module("opencut-editor-runtime-wasm", () => ({
	knowledgeDispatch: (...args: Parameters<typeof dispatch>) =>
		dispatch(...args),
}));
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: account.getStore()! }),
	accountDataRoot: () => join(root, account.getStore()!),
}));
mock.module("@/services/local-drive/server", () => ({
	listProjectMetadata: async () =>
		account.getStore() === "alice" ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }],
}));
const { operateKnowledge } = await import("../server/knowledge");
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-knowledge-host-test-"));
	const runtime = await createCanonicalTestRuntime();
	runtime.free();
	const glue =
		await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
	dispatch = glue.knowledgeDispatch;
});
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});

test("real WASM knowledge policy persists per account and rejects foreign ownership", async () => {
	const request = {
		type: "mutate",
		mutation: {
			expectedRevision: 0,
			idempotencyKey: "remember",
			change: {
				type: "create",
				key: { kind: "memory", id: "tone" },
				location: { type: "global" },
				content: {
					title: "My tone",
					body: "כתוב בעברית קצרה",
					tags: ["Hebrew"],
					enabled: true,
				},
			},
		},
	};
	const written = await account.run("alice", () =>
		operateKnowledge({ projectId: "a", request }),
	);
	expect(written.revision).toBe(1);
	expect(written.changed).toBe(true);
	const replay = await account.run("alice", () =>
		operateKnowledge({ projectId: "a", request }),
	);
	expect(replay.revision).toBe(1);
	expect(replay.changed).toBe(false);
	const current = await account.run("alice", () =>
		operateKnowledge({
			projectId: "b",
			request: { type: "context", query: "Hebrew", maxBytes: 24000 },
		}),
	);
	expect(JSON.stringify(current.data)).toContain("כתוב בעברית קצרה");
	const other = await account.run("bob", () =>
		operateKnowledge({
			projectId: "c",
			request: { type: "context", query: "Hebrew", maxBytes: 24000 },
		}),
	);
	expect(JSON.stringify(other.data)).not.toContain("כתוב בעברית קצרה");
	await expect(
		account.run("bob", () =>
			operateKnowledge({
				projectId: "a",
				request: { type: "context", query: "", maxBytes: 24000 },
			}),
		),
	).rejects.toThrow("owned project");
	const bobRoot = join(root, "bob", "editor-agent", "knowledge");
	await mkdir(bobRoot, { recursive: true });
	await copyFile(
		join(root, "alice", "editor-agent", "knowledge", "knowledge.json"),
		join(bobRoot, "knowledge.json"),
	);
	await expect(
		account.run("bob", () =>
			operateKnowledge({
				projectId: "c",
				request: { type: "context", query: "", maxBytes: 24000 },
			}),
		),
	).rejects.toThrow("another account");
});

test("concurrent knowledge writes cannot overwrite the same expected revision", async () => {
	const mutate = (id: string) =>
		account.run("alice", () =>
			operateKnowledge({
				projectId: "a",
				request: {
					type: "mutate",
					mutation: {
						expectedRevision: 1,
						idempotencyKey: id,
						change: {
							type: "create",
							key: { kind: "memory", id },
							location: { type: "project", projectId: "a" },
							content: {
								title: id,
								body: "Independent preference",
								tags: [],
								enabled: true,
							},
						},
					},
				},
			}),
		);
	const results = await Promise.allSettled([mutate("first"), mutate("second")]);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
	const state = await account.run("alice", () =>
		operateKnowledge({
			projectId: "a",
			request: {
				type: "search",
				query: "Independent",
				location: null,
				includeDisabled: true,
			},
		}),
	);
	expect(state.revision).toBe(2);
	expect(state.data).toHaveLength(1);
});

test("agent discovers the knowledge capability and reconciles a persisted write through real WASM", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		classic.document.metadata.id = "c";
		await runtime.invoke(
			"project.classic.session.attach",
			{ projectId: "c", expectedRevision: 0, classic },
			null,
		);
		const initial = runtime.agentStart(
			"registry-user",
			"knowledge-run",
			"Remember that captions should be in Hebrew",
		);
		runtime.agentCommand({
			type: "describe",
			epoch: initial.epoch,
			id: "knowledge.change",
		});
		runtime.agentCommand({
			type: "plan",
			epoch: initial.epoch,
			steps: [{ title: "Save the caption preference", status: "inProgress" }],
		});
		const prepared = runtime.agentProviderRequest("fixture-model");
		const result = runtime.agentProviderResponse(prepared.epoch, {
			id: "response-save",
			status: "completed",
			output: [
				{
					type: "function_call",
					call_id: "save",
					name: "opencut_editor",
					arguments: JSON.stringify({
						action: "invoke",
						id: "knowledge.change",
						input: {
							expectedKnowledgeRevision: 0,
							change: {
								type: "create",
								key: { kind: "memory", id: "captions" },
								location: { type: "project", projectId: "c" },
								content: {
									title: "Caption language",
									body: "כתוביות בעברית",
									tags: [],
									enabled: true,
								},
							},
						},
					}),
				},
			],
		});
		expect(result.phase).toBe("awaitingTool");
		const effect = result.pendingHost;
		const persisted = await account.run("registry-user", () =>
			operateKnowledge({
				projectId: effect.projectId,
				request: effect.request,
			}),
		);
		expect(persisted.changed).toBe(true);
		runtime.agentCommand({ type: "pause" });
		const pending = runtime.agentPendingHost();
		expect(pending).toEqual(effect);
		const replay = await account.run("registry-user", () =>
			operateKnowledge({
				projectId: pending.projectId,
				request: pending.request,
			}),
		);
		expect(replay.changed).toBe(false);
		const settled = runtime.agentSettleHost("registry-user", "c", effect.id, {
			type: "success",
			data: replay,
		});
		expect(settled.phase).toBe("paused");
		expect(settled.activities[0].ok).toBe(true);
		expect(runtime.agentSnapshot().receipts.at(-1)).toMatchObject({
			capabilityId: "knowledge.change",
			committed: true,
			externalOnly: true,
		});
		const context = await account.run("registry-user", () =>
			operateKnowledge({
				projectId: "c",
				request: { type: "context", query: "captions", maxBytes: 24000 },
			}),
		);
		expect(JSON.stringify(context.data)).toContain("כתוביות בעברית");
	} finally {
		runtime.free();
	}
}, 20_000);
