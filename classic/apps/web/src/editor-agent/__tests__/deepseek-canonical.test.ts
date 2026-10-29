import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { driveEditorHarness } from "../harness-client";

// The service boundary is authenticated by withAccount in production. This
// fixture controls only that identity; DSH and Rust are real implementations.
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: "alice" }),
}));
const { handleHarnessRequest } = await import("../server/harness-handler");

test("HTTP bridge + actual DSH native tools edit Classic through Rust and read back through app.state.read", async () => {
	const runtime = await createCanonicalTestRuntime();
	const controller = new AbortController();
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
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		runtime.agentStart("alice", "dsh-edit", "שנה את שם הפרויקט");
		classic.document.metadata.name = "נערך דרך DeepSeek Harness";
		const actions = [
			{
				action: "plan",
				steps: [{ title: "Rename and read back", status: "inProgress" }],
			},
			{ action: "describe", id: "project.classic.commit" },
			{ action: "invoke", id: "project.classic.commit", input: { classic } },
			{ action: "describe", id: "app.state.read" },
			{
				action: "invoke",
				id: "app.state.read",
				input: { pointer: "/project/classic/document/metadata/name" },
			},
			{
				action: "plan",
				steps: [{ title: "Rename and read back", status: "complete" }],
			},
			{ action: "complete", text: "שם הפרויקט עודכן ונבדק" },
		];
		let pending: { epoch: number; response: unknown } | undefined;
		let readBack: unknown;
		const calls: string[] = [];
		const result = await driveEditorHarness({
			accountId: "alice",
			projectId: "classic-project",
			model: "fixture-codex",
			signal: controller.signal,
			assertScope() {
				expect(runtime.snapshot().project.id).toBe("classic-project");
			},
			send: (async (_url, options) =>
				handleHarnessRequest(
					new Request("http://localhost/api/editor-agent/harness", options),
				)) as typeof fetch,
			async call(operation, round) {
				calls.push(`${operation}:${round}`);
				if (operation === "provider") {
					const request = runtime.agentProviderRequest("fixture-codex");
					expect(
						request.body.tools.map((tool: { name: string }) => tool.name),
					).toEqual(["opencut_editor"]);
					const action = actions[round - 1];
					if (!action)
						throw new Error("Unexpected provider call after completion");
					pending = {
						epoch: request.epoch,
						response: {
							id: `response-${round}`,
							status: "completed",
							output: [
								{
									type: "function_call",
									call_id: `call-${round}`,
									name: "opencut_editor",
									arguments: JSON.stringify(action),
								},
							],
						},
					};
					return pending;
				}
				if (!pending)
					throw new Error("No canonical response awaiting application");
				const current = pending;
				pending = undefined;
				const applied = runtime.agentProviderResponse(
					current.epoch,
					current.response,
				);
				expect(
					applied.activities.every((activity: { ok: boolean }) => activity.ok),
				).toBe(true);
				if (round === 5)
					readBack = applied.activities[0].output.result.result.data.value;
				if (applied.needsVerification)
					runtime.agentVerify(
						runtime.agentSnapshot().epoch,
						runtime.snapshot().revision,
						[],
					);
				return { phase: runtime.agentSnapshot().phase };
			},
		});
		expect(result).toBe("completed");
		expect(runtime.agentSnapshot().phase).toBe("completed");
		expect(readBack).toBe("נערך דרך DeepSeek Harness");
		expect(
			runtime
				.agentSnapshot()
				.receipts.some(
					(receipt: { capabilityId: string; committed: boolean }) =>
						receipt.capabilityId === "project.classic.commit" &&
						receipt.committed,
				),
		).toBe(true);
		expect(calls).toHaveLength(14);
	} finally {
		controller.abort();
		runtime.free();
	}
}, 60_000);

test("the canonical agent cannot turn a DSH call into shell/filesystem access or another project's edit", async () => {
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
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId: "classic-project", expectedRevision: 0, classic },
			null,
		);
		runtime.agentStart("alice", "dsh-scope", "Edit only this project");
		const open = runtime.agentCommand({
			type: "describe",
			epoch: runtime.agentSnapshot().epoch,
			id: "project.open",
		});
		expect(open.available).toBe(false);
		expect(() =>
			runtime.agentCommand({
				type: "invoke",
				epoch: runtime.agentSnapshot().epoch,
				callId: "host-path",
				id: "project.open",
				input: { path: "/tmp/arbitrary-file" },
			}),
		).toThrow();
		for (const id of [
			"shell.exec",
			"fs.read",
			"computer.click",
			"terminal.run",
		]) {
			expect(() =>
				runtime.agentCommand({
					type: "describe",
					epoch: runtime.agentSnapshot().epoch,
					id,
				}),
			).toThrow();
		}
		runtime.agentCommand({
			type: "describe",
			epoch: runtime.agentSnapshot().epoch,
			id: "app.state.read",
		});
		expect(() =>
			runtime.agentCommand({
				type: "invoke",
				epoch: runtime.agentSnapshot().epoch,
				callId: "cross-project",
				id: "app.state.read",
				input: { projectId: "someone-elses-film", pointer: "/project" },
			}),
		).toThrow("owned-project");
		expect(runtime.agentSnapshot().receipts).toHaveLength(0);
	} finally {
		runtime.free();
	}
}, 60_000);
