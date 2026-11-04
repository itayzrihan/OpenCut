import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { z } from "zod";
test("real browser WASM services external Director host IO and publishes the reference in the same canonical project", async () => {
	const rt = await createCanonicalTestRuntime();
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
		const pid = classic.document.metadata.id;
		rt.invokeSync(
			"project.classic.session.attach",
			{ projectId: pid, expectedRevision: 0, classic },
			{},
		);
		const state = rt.invokeSync("app.state.read", {}, {}).result.data.value;
		const reference = {
			id: "a".repeat(32),
			name: "physical-board.png",
			kind: "image",
			mime: "image/png",
			bytes: 1,
			storyboard: true,
		};
		let calls = 0;
		const receipt = await rt.invokeWithHost(
			"project.generative.request",
			{
				projectId: pid,
				expectedRevision: state.revision,
				operationId: "browser-reference",
				operation: {
					type: "importReference",
					name: reference.name,
					mime: reference.mime,
					dataBase64: "eA==",
					sha256: "b".repeat(64),
					storyboard: true,
				},
			},
			{},
			async (raw: unknown) => {
				const effect = z
					.object({
						adapter: z.literal("generativeReview"),
						projectId: z.literal(pid),
					})
					.passthrough()
					.parse(raw);
				expect(effect.projectId).toBe(pid);
				calls++;
				return {
					type: "success",
					data: {
						projectId: pid,
						revision: state.revision,
						reference,
						job: null,
						jobs: [],
					},
				};
			},
		);
		expect(calls).toBe(1);
		expect(receipt.result.data.reference).toEqual(reference);
		const read = rt.invokeSync(
			"app.state.read",
			{ pointer: "/project/extensions/generative" },
			{},
		).result.data.value;
		expect(read.references[0]).toEqual(reference);
	} finally {
		rt.free();
	}
});
