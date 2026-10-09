/* eslint-disable opencut/prefer-object-params -- Test transport shorthand mirrors the account-scoped fixture calls. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	mkdtemp,
	mkdir,
	writeFile,
	rm,
	readFile,
	copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { EditorSessionClient, EditorSessionFailure } from "../session-client";

const account = new AsyncLocalStorage<string>();
let root: string;
let transition: typeof import("opencut-editor-runtime-wasm").sessionStoreTransition;
mock.module("opencut-editor-runtime-wasm", () => ({
	sessionStoreTransition: (...args: Parameters<typeof transition>) =>
		transition(...args),
}));
mock.module("opencut-wasm", () => ({
	mediaLinkThresholdBytes: () => {
		throw new Error("Media IO is outside this session test");
	},
	mediaStorageDisposition: () => {
		throw new Error("Media IO is outside this session test");
	},
}));
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: account.getStore()! }),
	accountDataRoot: () => join(root, account.getStore()!),
	accountsRoot: () => root,
	canImportLegacy: () => false,
}));
const { operateEditorSession } = await import("../server/session-store");
const { getProject, putProject, getHistory, putHistory } =
	await import("@/services/local-drive/server");
const projectId = "classic-project";
let classic: CanonicalClassicSnapshot;
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "opencut-session-host-test-"));
	const runtime = await createCanonicalTestRuntime();
	runtime.free();
	const glue =
		await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
	transition = glue.sessionStoreTransition;
	classic = JSON.parse(
		await readFile(
			new URL(
				"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	for (const owner of ["alice", "bob", "carol", "dora"]) {
		const directory = join(root, owner, "projects", projectId);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "project.json"),
			JSON.stringify(classic.document),
		);
		await writeFile(
			join(directory, "history.json"),
			JSON.stringify({
				projectId,
				schemaVersion: 1,
				undoStack: [],
				redoStack: [],
			}),
		);
	}
});

test("browser save queue reconciles a lost acknowledgement before capturing later edits", async () => {
	const requests: Record<string, unknown>[] = [];
	let loseReply = true;
	const client = new EditorSessionClient({
		accountId: "carol",
		projectId,
		sessionId: "tab-c",
		exchange: async (request) => {
			requests.push(structuredClone(request));
			const result = await operate("carol", request);
			if (request.type === "commit" && loseReply) {
				loseReply = false;
				throw new TypeError("Network disconnected after commit");
			}
			return result;
		},
	});
	await client.acquire({ expectedGeneration: 0 });
	const runtime = await createCanonicalTestRuntime();
	try {
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId, expectedRevision: 0, classic },
			null,
		);
		let captures = 0;
		const capture = () => {
			captures += 1;
			return {
				archive: runtime.invokeSync(
					"project.classic.session.archive",
					{ projectId, persistableOnly: true },
					null,
				).result.data,
				agentCheckpoint: null,
			};
		};
		await expect(client.save(capture)).rejects.toThrow("disconnected");
		expect(captures).toBe(1);
		await Promise.all([client.save(capture), client.save(capture)]);
		expect(captures).toBe(3);
		const commits = requests.filter((request) => request.type === "commit");
		expect(commits).toHaveLength(4);
		expect(commits[1]).toEqual(commits[0]);
		expect(commits.map((request) => request.expectedStorageRevision)).toEqual([
			0, 0, 1, 2,
		]);
		expect((await client.read()).storageRevision).toBe(3);
		await client.renew();
		await client.release();
		await expect(client.save(capture)).rejects.toThrow("ownership");
	} finally {
		runtime.free();
	}
}, 20_000);
afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});
const operate = (owner: string, request: unknown) =>
	account.run(owner, () => operateEditorSession({ projectId, request }));

test("paired host saves preserve pending image, embedding and UI operations without dispatch", async () => {
	const acquired = await operate("dora", {
		type: "acquire",
		sessionId: "pending-host-tab",
		expectedGeneration: 0,
		takeOver: false,
	});
	let storageRevision = acquired.storageRevision;
	const observer = new EditorSessionClient({
		accountId: "dora",
		projectId,
		sessionId: "read-pending-host",
		exchange: (request) => operate("dora", request),
	});
	for (const feature of [
		{
			id: "imagegen.generate",
			adapter: "subscriptionImage",
			input: {
				operationId: "same-image-operation",
				title: "Turquoise circle",
				prompt: "A turquoise circle on transparent background",
				transparentBackground: true,
			},
		},
		{
			id: "hyperframes.examples.embed",
			adapter: "hyperframesEmbedding",
			input: { query: "glass title" },
		},
		{
			id: "editor.ui.control",
			adapter: "editorUiControl",
			input: {
				snapshotId: "snapshot-1",
				targetId: "target-1",
				gesture: { type: "click" },
			},
		},
	]) {
		const runtime = await createCanonicalTestRuntime();
		const reopened = await createCanonicalTestRuntime();
		try {
			runtime.invokeSync(
				"project.classic.session.attach",
				{ projectId, expectedRevision: 0, classic },
				null,
			);
			const run = runtime.agentStart(
				"dora",
				`pending-${feature.id}`,
				"Test checkpoint recovery",
			);
			runtime.agentCommand({
				type: "describe",
				epoch: run.epoch,
				id: feature.id,
			});
			runtime.agentCommand({
				type: "plan",
				epoch: run.epoch,
				steps: [
					{ title: "Perform the requested host action", status: "inProgress" },
				],
			});
			const request = runtime.agentProviderRequest("fixture-model");
			const round = runtime.agentProviderResponse(request.epoch, {
				id: `response-${feature.id}`,
				status: "completed",
				output: [
					{
						type: "function_call",
						call_id: "pending-host-call",
						name: "opencut_editor",
						arguments: JSON.stringify({
							action: "invoke",
							id: feature.id,
							input: feature.input,
						}),
					},
				],
			});
			expect(round.pendingHost.adapter).toBe(feature.adapter);
			const bundle = {
				archive: runtime.invokeSync(
					"project.classic.session.archive",
					{ projectId, persistableOnly: true },
					null,
				).result.data,
				agentCheckpoint: runtime.agentCheckpoint(),
			};
			const saved = await operate("dora", {
				type: "commit",
				sessionId: "pending-host-tab",
				generation: 1,
				expectedStorageRevision: storageRevision,
				requestId: `save-${feature.id}`,
				bundle,
			});
			storageRevision = saved.storageRevision;
			const view = await observer.read();
			if (!view.saved?.bundle.agentCheckpoint)
				throw new Error(
					"Pending host checkpoint was not paired with the project",
				);
			expect(view.saved.bundle.agentCheckpoint).toBe(bundle.agentCheckpoint);
			reopened.invokeSync(
				"project.classic.session.restore",
				{ projectId, expectedRevision: 0, archive: view.saved.bundle.archive },
				null,
			);
			expect(
				reopened.agentRestoreCheckpoint(
					"dora",
					view.saved.bundle.agentCheckpoint,
				).phase,
			).toBe("paused");
			expect(reopened.agentPendingHost().request).toEqual(
				round.pendingHost.request,
			);
			expect(reopened.snapshot()).toEqual(runtime.snapshot());
			expect(() => reopened.agentProviderRequest("fixture-model")).toThrow();
			// Saving/reopening installs only the host queue. No image job or media IO
			// can have been dispatched by the session validator.
			expect(
				await readFile(
					join(root, "dora", "projects", projectId, "history.json"),
					"utf8",
				),
			).not.toContain("imagegen-");
		} finally {
			runtime.free();
			reopened.free();
		}
	}
}, 30_000);

test("file host atomically saves canonical project, undo and run; legacy paths cannot overwrite it", async () => {
	const preview = await operate("alice", { type: "read" });
	expect(preview.storageRevision).toBe(0);
	expect(preview.legacyProject).toEqual(classic.document);
	const path = join(root, "alice", "projects", projectId, "project.json");
	expect(await readFile(path, "utf8")).not.toContain("__opencutEditorSession");
	const acquired = await operate("alice", {
		type: "acquire",
		sessionId: "tab-a",
		expectedGeneration: 0,
		takeOver: false,
	});
	expect(acquired.legacyHistory).toMatchObject({ schemaVersion: 1 });
	const runtime = await createCanonicalTestRuntime();
	try {
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId, expectedRevision: 0, classic },
			null,
		);
		const run = runtime.agentStart("alice", "saved-run", "Rename the film");
		runtime.agentCommand({
			type: "describe",
			epoch: run.epoch,
			id: "project.classic.commit",
		});
		runtime.agentCommand({
			type: "plan",
			epoch: run.epoch,
			steps: [{ title: "Rename", status: "inProgress" }],
		});
		const edited = structuredClone(classic);
		edited.document.metadata.name = "Atomically saved film";
		runtime.agentCommand({
			type: "invoke",
			epoch: run.epoch,
			callId: "rename",
			id: "project.classic.commit",
			input: { classic: edited },
		});
		const bundle = {
			archive: runtime.invokeSync(
				"project.classic.session.archive",
				{ projectId, persistableOnly: true },
				null,
			).result.data,
			agentCheckpoint: runtime.agentCheckpoint(),
		};
		const request = {
			type: "commit",
			sessionId: "tab-a",
			generation: 1,
			expectedStorageRevision: 0,
			requestId: "save",
			bundle,
		};
		const saved = await operate("alice", request);
		expect(saved.storageRevision).toBe(1);
		expect((await operate("alice", request)).storageRevision).toBe(1);
		const view = await account.run("alice", () => getProject(projectId));
		expect(view).toMatchObject({ metadata: { name: "Atomically saved film" } });
		expect(view).not.toHaveProperty("__opencutEditorSession");
		const history = await account.run("alice", () => getHistory(projectId));
		expect(history).toMatchObject({
			canonicalArchive: bundle.archive,
			agentCheckpoint: bundle.agentCheckpoint,
		});
		await expect(
			account.run("alice", () => putProject(projectId, classic.document)),
		).rejects.toThrow("canonical");
		await expect(
			account.run("alice", () => putHistory(projectId, {})),
		).rejects.toThrow("Canonical");
		const competing = await Promise.allSettled(
			["one", "two"].map((requestId) =>
				operate("alice", { ...request, requestId, expectedStorageRevision: 1 }),
			),
		);
		expect(
			competing.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			competing.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const recovered = await operate("alice", {
			type: "acquire",
			sessionId: "tab-b",
			expectedGeneration: 1,
			takeOver: true,
		});
		expect(recovered.saved).toMatchObject({ bundle, project: edited.document });
		expect(recovered.legacyProject).toBeNull();
		await expect(
			operate("alice", {
				...request,
				requestId: "stale",
				expectedStorageRevision: 2,
			}),
		).rejects.toThrow("ownership");
		const reopened = await createCanonicalTestRuntime();
		try {
			reopened.invokeSync(
				"project.classic.session.restore",
				{ projectId, expectedRevision: 0, archive: bundle.archive },
				null,
			);
			expect(
				reopened.agentRestoreCheckpoint("alice", bundle.agentCheckpoint).phase,
			).toBe("paused");
			reopened.invokeSync("history.undo", {}, null);
			expect(reopened.snapshot().project.classic.document.metadata.name).toBe(
				classic.document.metadata.name,
			);
		} finally {
			reopened.free();
		}
	} finally {
		runtime.free();
	}
}, 20_000);

test("same project identifier in another account stays private even if a session file is copied", async () => {
	const bob = await operate("bob", { type: "read" });
	expect(bob.saved).toBeNull();
	expect(bob.legacyProject).toEqual(classic.document);
	await copyFile(
		join(root, "alice", "projects", projectId, "project.json"),
		join(root, "bob", "projects", projectId, "project.json"),
	);
	await expect(operate("bob", { type: "read" })).rejects.toThrow(
		"another account",
	);
});

test("losing the outer batch lock prevents session publication and leaves the saved record unchanged", async () => {
	const path = join(root, "alice", "projects", projectId, "project.json");
	const before = await readFile(path, "utf8");
	for (const failAt of [1, 2, 3]) {
		let checks = 0;
		await expect(
			account.run("alice", () =>
				operateEditorSession({
					projectId,
					request: {
						type: "acquire",
						sessionId: "unpublished-owner",
						expectedGeneration: 2,
						takeOver: true,
					},
					assertHostLock: () => {
						if (++checks === failAt) throw new Error("Outer batch lock lost");
					},
				}),
			),
		).rejects.toThrow("Outer batch lock lost");
		expect(checks).toBe(failAt);
		expect(await readFile(path, "utf8")).toBe(before);
	}
});

test("an ownership race reopens the latest saved version read-only without repeating takeover", async () => {
	const winnerClient = new EditorSessionClient({
		accountId: "carol",
		projectId,
		sessionId: "race-winner",
		exchange: (request) => operate("carol", request),
	});
	const observed = await winnerClient.read();
	const winner = await winnerClient.acquire({
		expectedGeneration: observed.generation,
		takeOver: true,
	});
	const requests: string[] = [];
	const client = new EditorSessionClient({
		accountId: "carol",
		projectId,
		sessionId: "race-loser",
		exchange: async (request) => {
			requests.push(String(request.type));
			try {
				return await operate("carol", request);
			} catch (error) {
				throw new EditorSessionFailure({
					message: error instanceof Error ? error.message : "Session conflict",
					definitive: true,
				});
			}
		},
	});
	const outcome = await client.acquireOrObserve({
		expectedGeneration: observed.generation,
		takeOver: true,
	});
	expect(outcome.acquired).toBe(false);
	expect(outcome.view.generation).toBe(winner.generation);
	expect(outcome.view.lease?.sessionId).toBe("race-winner");
	expect(outcome.view.saved).toEqual(winner.saved);
	expect(requests).toEqual(["acquire", "read"]);
	let captured = false;
	await expect(
		client.save(() => {
			captured = true;
			throw new Error("Read-only save must never capture");
		}),
	).rejects.toThrow();
	expect(captured).toBe(false);
	client.dispose();
	const ambiguousRequests: string[] = [];
	const ambiguous = new EditorSessionClient({
		accountId: "carol",
		projectId,
		exchange: async (request) => {
			ambiguousRequests.push(String(request.type));
			throw new TypeError("Acquire acknowledgement lost");
		},
	});
	await expect(
		ambiguous.acquireOrObserve({ expectedGeneration: winner.generation }),
	).rejects.toThrow("acknowledgement lost");
	expect(ambiguousRequests).toEqual(["acquire"]);
	ambiguous.dispose();
	winnerClient.dispose();
});
