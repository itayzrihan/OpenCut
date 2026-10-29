// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

test("the composer changes permissions in a canonical transaction and Plan finishes without executing edits", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		runtime.installDesktopUi();
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
		const revision = runtime.snapshot().revision;
		runtime.beginTransaction("classic-project", revision);
		runtime.invokeSync(
			"agent.policy.set",
			{
				projectId: "classic-project",
				expectedRevision: revision,
				mode: "plan",
				computerAccess: false,
			},
			null,
		);
		const read = runtime.invokeSync(
			"app.state.read",
			{ projectId: "classic-project", pointer: "/agentPolicy" },
			null,
		);
		expect(read.result.data.value.mode).toBe("plan");
		runtime.commitTransaction("Change agent permissions", null);
		const snapshot = runtime.agentStart(
			"alice",
			"plan-test",
			"Propose an edit without changing the project",
		);
		expect(() =>
			runtime.agentModelAction(snapshot.epoch, "blocked-write", {
				action: "invoke",
				id: "project.classic.commit",
				input: { classic },
			}),
		).toThrow("Plan mode");
		runtime.agentModelAction(snapshot.epoch, "propose", {
			action: "plan",
			steps: [{ title: "Proposed rename", status: "pending" }],
		});
		runtime.agentModelAction(snapshot.epoch, "finish-plan", {
			action: "complete",
			text: "Proposed rename; no edits executed",
		});
		expect(runtime.agentSnapshot().phase).toBe("completed");
		expect(runtime.snapshot().project.classic).toEqual(classic);
	} finally {
		runtime.free();
	}
});
