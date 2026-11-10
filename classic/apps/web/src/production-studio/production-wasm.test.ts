// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
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

test("browser WASM imports the exact native image artifact into one production reference slot without model binary", async () => {
	const runtime = await createCanonicalTestRuntime();
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
		const bytes = new Uint8Array(
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=",
				"base64",
			),
		);
		let imageHostCalls = 0;
		const generated = await runtime.invokeWithHost(
			"imagegen.generate",
			{
				projectId,
				expectedRevision: revision(),
				operationId: "qa-native-image",
				title: "Hero",
				prompt: "A synthetic one-pixel QA image",
				referenceArtifactIds: [],
			},
			{},
			async (raw: unknown) => {
				z.object({
					adapter: z.literal("subscriptionImage"),
					projectId: z.literal(projectId),
				})
					.passthrough()
					.parse(raw);
				imageHostCalls++;
				return {
					type: "success",
					data: {
						projectId,
						operationId: "qa-native-image",
						mediaId: "qa-generated-hero",
						fileName: "qa-generated-hero.png",
						lastModified: 1,
						artifact: runtime.storeArtifact(
							bytes,
							"image/png",
							1,
							1,
							undefined,
						),
					},
				};
			},
		);
		const artifact = generated.result.data.artifact;
		const expectedRevision = revision();
		const imported = await runtime.invokeWithHost(
			"project.generative.request",
			{
				projectId,
				expectedRevision,
				operationId: "qa-artifact-import",
				operation: {
					type: "importArtifactReference",
					artifactId: artifact.id,
					name: "Hero.png",
					storyboard: false,
				},
			},
			{},
			async (raw: unknown) => {
				const effect = z
					.object({
						adapter: z.literal("generativeReview"),
						projectId: z.literal(projectId),
						request: z
							.object({
								operation: z
									.object({
										type: z.literal("importReference"),
										name: z.literal("Hero.png"),
										mime: z.literal("image/png"),
										dataBase64: z.string(),
										sha256: z.string(),
										storyboard: z.literal(false),
									})
									.strict(),
							})
							.passthrough(),
					})
					.passthrough()
					.parse(raw);
				expect(
					new Uint8Array(
						Buffer.from(effect.request.operation.dataBase64, "base64"),
					),
				).toEqual(bytes);
				expect(effect.request.operation.sha256).toBe(artifact.sha256);
				return {
					type: "success",
					data: {
						projectId,
						revision: expectedRevision,
						reference: {
							id: "b".repeat(32),
							name: "Hero.png",
							mime: "image/png",
							kind: "image",
							bytes: bytes.length,
							storyboard: false,
						},
						job: null,
						jobs: [],
					},
				};
			},
		);
		expect(imageHostCalls).toBe(1);
		expect(JSON.stringify(imported.result.data)).not.toContain("dataBase64");
		runtime.invokeSync(
			"project.production.edit",
			{
				projectId,
				expectedRevision: revision(),
				change: { type: "createReferenceSlot", slotId: "hero", label: "Hero" },
			},
			{},
		);
		runtime.invokeSync(
			"project.production.edit",
			{
				projectId,
				expectedRevision: revision(),
				change: {
					type: "addReferenceVersion",
					slotId: "hero",
					expectedSlotVersion: 1,
					referenceId: imported.result.data.reference.id,
					source: "generated",
				},
			},
			{},
		);
		const workspace = runtime.invokeSync(
			"project.production.read",
			{ projectId },
			{},
		).result.data.workspace;
		expect(workspace.referenceSlots[0].versions[0].referenceId).toBe(
			"b".repeat(32),
		);
		expect(workspace.referenceSlots[0].approvedVersion).toBeNull();
		expect(runtime.readArtifact(artifact.id)).toEqual(bytes);
	} finally {
		runtime.free();
	}
});
