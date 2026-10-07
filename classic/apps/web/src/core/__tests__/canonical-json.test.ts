/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- fixtures and results cross the real Rust JSON contract. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCanonicalTestRuntime } from "./canonical-runtime-fixture";

test("canonical sync and async transports preserve JSON omission, null and history", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			readFileSync(
				new URL(
					"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
					import.meta.url,
				),
				"utf8",
			),
		);
		classic.document.transportExtension = {
			absent: undefined,
			cleared: null,
			nested: { absent: undefined, value: 3 },
			array: [undefined, null, { absent: undefined, cleared: null }],
		};
		const before = JSON.parse(JSON.stringify(classic));
		runtime.invokeSync(
			"project.classic.session.attach",
			{
				projectId: "classic-project",
				expectedRevision: 0,
				classic,
			},
			undefined,
		);
		const snapshot = () =>
			runtime.snapshot() as {
				revision: number;
				project: { classic: typeof classic };
			};
		expect(snapshot().project.classic).toStrictEqual(before);
		classic.document.transportExtension.nested.value = 4;
		await runtime.invoke(
			"project.classic.commit",
			{
				projectId: "classic-project",
				expectedRevision: snapshot().revision,
				classic,
			},
			{ metadata: { absent: undefined, cleared: null } },
		);
		expect(snapshot().project.classic).toStrictEqual(
			JSON.parse(JSON.stringify(classic)),
		);
		runtime.invokeSync("history.undo", {}, undefined);
		expect(snapshot().project.classic).toStrictEqual(before);
		runtime.invokeSync("history.redo", {}, undefined);
		const after = snapshot();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() =>
			runtime.invokeSync("project.classic.commit", circular, undefined),
		).toThrow();
		expect(snapshot()).toStrictEqual(after);
		const restored = await createCanonicalTestRuntime();
		try {
			restored.restore(runtime.serialize());
			expect(restored.snapshot()).toStrictEqual(after);
		} finally {
			restored.free();
		}
	} finally {
		runtime.free();
	}
}, 20_000);
