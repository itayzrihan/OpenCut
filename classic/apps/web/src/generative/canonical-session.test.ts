import { expect, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
test("Director conversation survives real WASM serialization and canonical read", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const create = runtime.invokeSync(
			"project.create",
			{ name: "Director browser contract" },
			{},
		);
		expect(create.result.data).toBeTruthy();
		const state = runtime.invokeSync("app.state.read", {}, {}).result.data
			.value;
		runtime.invokeSync(
			"project.generative.edit",
			{
				projectId: state.project.id,
				expectedRevision: state.revision,
				change: {
					type: "message",
					message: {
						id: "m1",
						role: "user",
						text: "Show our city then its mysterious forest",
					},
				},
			},
			{},
		);
		const before = runtime.invokeSync(
			"project.generative.read",
			{ projectId: state.project.id },
			{},
		).result.data;
		expect(before.document.messages[0].text).toBe(
			"Show our city then its mysterious forest",
		);
		expect(before.instructions).toContain("At most ONE");
		const serialized = runtime.serialize();
		runtime.restore(serialized);
		const after = runtime.invokeSync(
			"app.state.read",
			{ pointer: "/project/extensions/generative" },
			{},
		).result.data.value;
		expect(after.messages).toEqual(before.document.messages);
	} finally {
		runtime.free();
	}
});
