// @opencut-test-wasm: real
import { beforeAll, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

const account = new AsyncLocalStorage<string>();
let policy: typeof import("opencut-editor-runtime-wasm").hyperframesReferenceSource;
mock.module("opencut-editor-runtime-wasm", () => ({
	hyperframesReferenceSource: (...args: Parameters<typeof policy>) =>
		policy(...args),
}));
mock.module("@/accounts/server", () => ({
	requireAccount: () => {
		const id = account.getStore();
		if (!id) throw new Error("Unauthenticated");
		return { id };
	},
}));
mock.module("@/services/local-drive/server", () => ({
	listProjectMetadata: async () =>
		account.getStore() === "alice"
			? [{ id: "classic-project" }]
			: [{ id: "foreign" }],
}));
const { readBundledReference, operateHyperframesReference } =
	await import("../server/hyperframes-references");
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const directory = join(root, "resources/hyperframes");
const request = {
	projectId: "classic-project",
	expectedRevision: 1,
	id: "lt-clean-bar",
	upstreamCommit: "4c4b8574406cc566d28778a13f22c072d727a871",
	filePath: "lt-clean-bar.html",
	limit: 71,
};
beforeAll(async () => {
	const runtime = await createCanonicalTestRuntime();
	runtime.free();
	policy = (
		await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js")
	).hyperframesReferenceSource;
});

test("the real source policy and bounded disk adapter preserve exact source and reject tampering", async () => {
	const plan = policy(request);
	const original = await readFile(join(directory, plan.relativePath), "utf8");
	let offset = 0;
	let reconstructed = "";
	for (;;) {
		const page = await readBundledReference({
			request: { ...request, offset },
			directory,
		});
		expect(Array.from(page.text).length).toBeLessThanOrEqual(71);
		reconstructed += page.text;
		if (page.nextOffset === null) break;
		expect(page.nextOffset).toBeGreaterThan(offset);
		offset = page.nextOffset;
	}
	expect(reconstructed).toBe(original);
	const damagedRoot = join(
		root,
		".local",
		"hyperframes-reference-io-tests",
		crypto.randomUUID(),
	);
	const damagedPath = join(damagedRoot, plan.relativePath);
	await mkdir(dirname(damagedPath), { recursive: true });
	await writeFile(damagedPath, original.replace("<", ">"));
	await expect(
		readBundledReference({ request, directory: damagedRoot }),
	).rejects.toThrow("hash differs");
	await expect(
		readBundledReference({
			request: { ...request, filePath: "../../.env" },
			directory,
		}),
	).rejects.toThrow("Unknown file");
	await expect(
		account.run("bob", () =>
			operateHyperframesReference({ projectId: "classic-project", request }),
		),
	).rejects.toThrow("owned project");
	await expect(
		account.run("alice", () =>
			operateHyperframesReference({
				projectId: "classic-project",
				request: { ...request, projectId: "foreign" },
			}),
		),
	).rejects.toThrow("scope");
});

test("UI host reads use the actual registry and release their slot after failures", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const classic = JSON.parse(
			await readFile(
				join(root, "crates/editor-api/tests/fixtures/classic-project.json"),
				"utf8",
			),
		);
		runtime.invokeSync(
			"project.classic.session.attach",
			{ projectId: request.projectId, expectedRevision: 0, classic },
			null,
		);
		const before = runtime.invokeSync("app.state.read", {}, null);
		const result = await runtime.invokeReadWithHost(
			"hyperframes.examples.source.read",
			request,
			async (effect: { request: unknown; adapter: string }) => {
				expect(effect.adapter).toBe("hyperframesReferences");
				return {
					type: "success",
					data: await readBundledReference({
						request: effect.request,
						directory,
					}),
				};
			},
		);
		expect(result.result.data.text).toHaveLength(71);
		await expect(
			runtime.invokeReadWithHost(
				"hyperframes.examples.source.read",
				request,
				async () => {
					throw new Error("cancelled");
				},
			),
		).rejects.toBeDefined();
		await expect(
			runtime.invokeReadWithHost(
				"hyperframes.examples.source.read",
				request,
				async () => ({ type: "success", data: {} }),
			),
		).rejects.toBeDefined();
		await expect(
			runtime.invokeReadWithHost(
				"hyperframes.examples.source.read",
				request,
				async (effect: { request: unknown }) => ({
					type: "success",
					data: await readBundledReference({
						request: effect.request,
						directory,
					}),
				}),
			),
		).resolves.toBeDefined();
		await expect(
			runtime.invokeReadWithHost("app.state.patch", {}, async () => {
				throw new Error("must not run");
			}),
		).rejects.toBeDefined();
		expect(runtime.invokeSync("app.state.read", {}, null)).toEqual(before);
	} finally {
		runtime.free();
	}
}, 30000);
