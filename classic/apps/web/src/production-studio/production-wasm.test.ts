// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";

test("browser WASM session save/reopen retains production row versions, image approval and exact Director handoff with Undo", async () => {
	const runtime = await createCanonicalTestRuntime();
	const reopened = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				new URL(
					"../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		const projectId = classic.document.metadata.id;
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId, expectedRevision: 0, classic },
			{},
		);
		const revision = () =>
			runtime.invokeSync("app.state.read", {}, {}).result.data.value.revision;
		const invoke = ({
			capability,
			input,
		}: {
			capability: string;
			input: Record<string, unknown>;
		}) =>
			runtime.invokeSync(
				capability,
				{ projectId, expectedRevision: revision(), ...input },
				{},
			);
		invoke({
			capability: "project.production.edit",
			input: {
				change: {
					type: "importScript",
					rowIdPrefix: "script",
					text: "שלום לעולם\nمرحبا بالعالم",
					sourceLanguage: "he",
					defaultDurationMs: 4000,
				},
			},
		});
		invoke({
			capability: "project.production.edit",
			input: {
				change: {
					type: "editScriptRow",
					rowId: "script-1",
					expectedRowVersion: 1,
					content: {
						startMs: 0,
						endMs: 4000,
						sourceLanguage: "he",
						sourceText: "שלום לעולם",
						latinTransliteration: "Shalom la-olam",
						visualDescription: "Open the door",
						speaker: "Dana",
						timingEstimated: true,
					},
				},
			},
		});
		invoke({
			capability: "project.generative.edit",
			input: {
				change: {
					type: "reference",
					reference: {
						id: "a".repeat(32),
						name: "synthetic.png",
						kind: "image",
						mime: "image/png",
						bytes: 17,
					},
				},
			},
		});
		invoke({
			capability: "project.production.edit",
			input: {
				change: { type: "createReferenceSlot", slotId: "hero", label: "Hero" },
			},
		});
		invoke({
			capability: "project.production.edit",
			input: {
				change: {
					type: "addReferenceVersion",
					slotId: "hero",
					expectedSlotVersion: 1,
					referenceId: "a".repeat(32),
					source: "uploaded",
				},
			},
		});
		invoke({
			capability: "project.production.edit",
			input: {
				change: {
					type: "approveReference",
					slotId: "hero",
					expectedSlotVersion: 2,
					version: 1,
					approved: true,
				},
			},
		});
		invoke({
			capability: "project.production.handoff",
			input: {
				handoffId: "browser-handoff",
				request: "Preserve the source dialogue",
			},
		});
		const before = runtime.invokeSync(
			"app.state.read",
			{ pointer: "/project/extensions" },
			{},
		).result.data.value;
		expect(before.productionStudio.scriptRows[0].versions).toHaveLength(2);
		expect(
			before.generative.productionHandoff.rows[0].content.latinTransliteration,
		).toBe("Shalom la-olam");
		const session = new CanonicalClassicSession({ runtime, projectId });
		const saved = JSON.parse(JSON.stringify(session.archive()));
		expect(saved.schemaVersion).toBe(6);
		expect(saved.historyEncoding).toBe("chained");
		const restored = new CanonicalClassicSession({
			runtime: reopened,
			projectId,
		});
		restored.restore(saved);
		const read = () =>
			reopened.invokeSync(
				"app.state.read",
				{ pointer: "/project/extensions" },
				{},
			).result.data.value;
		expect(read()).toEqual(before);
		restored.undo();
		expect(read().generative.productionHandoff).toBeUndefined();
		expect(read().productionStudio.referenceSlots[0].approvedVersion).toBe(1);
		restored.undo();
		expect(
			read().productionStudio.referenceSlots[0].approvedVersion,
		).toBeNull();
		restored.redo();
		restored.redo();
		expect(read()).toEqual(before);
	} finally {
		runtime.free();
		reopened.free();
	}
});
