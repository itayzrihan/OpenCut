// Local acceptance: actual pinned model + actual canonical WASM, no provider billing.
import { mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanonicalTestRuntime } from "../src/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "../src/core/canonical-classic-session";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = join(root, ".local", "hyperframes-semantic-live");
const account = new AsyncLocalStorage<string>();
mock.module("@/accounts/server", () => ({
	requireAccount: () => ({ id: account.getStore() ?? "unauthenticated" }),
	accountDataRoot: () =>
		join(evidence, account.getStore() ?? "unauthenticated"),
}));
mock.module("@/services/local-drive/server", () => ({
	listProjectMetadata: async () =>
		account.getStore() === "acceptance" ? [{ id: "classic-project" }] : [],
}));
const runtime = await createCanonicalTestRuntime();
const glue =
	await import("../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
mock.module("opencut-editor-runtime-wasm", () => ({
	hyperframesEmbeddingPlan: glue.hyperframesEmbeddingPlan,
}));
const { embedReference } =
	await import("../src/editor-agent/server/hyperframes-embedding");
const session = new CanonicalClassicSession({
	runtime,
	projectId: "classic-project",
});
try {
	session.attach({
		classic: JSON.parse(
			await readFile(
				join(root, "crates/editor-api/tests/fixtures/classic-project.json"),
				"utf8",
			),
		),
	});
	const queries = [
		"a translucent glossy title over a video",
		"animated business metrics and financial numbers",
		"כותרת זכוכית",
	];
	const results = [];
	for (const query of queries) {
		const started = Date.now();
		const embedding = await account.run("acceptance", () =>
			embedReference({
				projectId: "classic-project",
				request: {
					projectId: "classic-project",
					expectedRevision: session.status().revision,
					query,
				},
				signal: new AbortController().signal,
			}),
		);
		const hits = session.searchHyperframesExamples({
			query,
			embedding,
			limit: 5,
		});
		if (hits.searchMode !== "semanticLocalBge" || hits.items.length !== 5)
			throw new Error(
				"Actual model did not produce canonical semantic results",
			);
		results.push({
			query,
			normalizedQuery: embedding.normalizedQuery,
			modelRevision: embedding.modelRevision,
			dimensions: embedding.vector.length,
			vectorNorm: embedding.vector.reduce(
				(sum, value) => sum + value * value,
				0,
			),
			durationMs: Date.now() - started,
			...hits,
		});
	}
	let foreignRejected = false;
	try {
		await account.run("foreign", () =>
			embedReference({
				projectId: "classic-project",
				request: {
					projectId: "classic-project",
					expectedRevision: session.status().revision,
					query: "title",
				},
				signal: new AbortController().signal,
			}),
		);
	} catch {
		foreignRejected = true;
	}
	if (!foreignRejected) throw new Error("Foreign account read was accepted");
	const report = {
		timestamp: new Date().toISOString(),
		actualModel: true,
		actualCanonicalRuntime: true,
		foreignRejected,
		results,
	};
	const path = join(evidence, "report.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(report, null, 2));
	console.log(
		JSON.stringify({
			path,
			queries: results.map((result) => ({
				query: result.query,
				ids: result.items.map((item) => item.id),
			})),
		}),
	);
} finally {
	session.dispose();
}
