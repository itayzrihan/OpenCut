// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Narrow host fixture delegates document operations to the real registry. */
import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";
import type { EditorCore } from "@/core";
import type { PreparedHyperframesFolder } from "../folder";

let commit: ((folder: PreparedHyperframesFolder) => unknown) | undefined;
mock.module("@/core/load-canonical-runtime", () => ({
	loadCanonicalRuntime: createCanonicalTestRuntime,
}));
mock.module("../import-folder", () => ({
	importHyperframesFolder: async ({
		folder,
	}: {
		folder: PreparedHyperframesFolder;
	}) => commit!(folder),
}));
const { importHyperframesExample } = await import("../import-example");

test("prepared package IO reads pinned pages and delivers an editable source to canonical import; cancellation never commits", async () => {
	const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
	const runtime = await createCanonicalTestRuntime();
	const session = new CanonicalClassicSession({
		runtime,
		projectId: "classic-project",
	});
	try {
		const glue =
			await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
		session.attach({
			classic: JSON.parse(
				await readFile(
					path.join(
						root,
						"crates/editor-api/tests/fixtures/classic-project.json",
					),
					"utf8",
				),
			),
		});
		const catalog = JSON.parse(
			await readFile(
				path.join(root, "resources/hyperframes/catalog.json"),
				"utf8",
			),
		);
		const candidate = catalog.items.find(
			(item: { prepared?: unknown }) => item.prepared,
		);
		let committed = 0;
		let pages = 0;
		commit = (folder) => {
			committed++;
			return session.importHyperframes({
				name: folder.name,
				source: folder.source,
				resolvedDurationSeconds: folder.inspection.durationSeconds ?? 5,
			});
		};
		const editor = {
			project: {
				getActiveOrNull: () => ({ metadata: { id: "classic-project" } }),
			},
			playback: { getCurrentTime: () => 0 },
			scenes: { getActiveSceneOrNull: () => ({ id: "main-scene" }) },
			command: {
				readHyperframesExample: ({
					id,
					upstreamCommit,
				}: {
					id: string;
					upstreamCommit: string;
				}) => session.readHyperframesExample({ id, upstreamCommit }),
				readHyperframesExampleSource: async ({
					projectId: _projectId,
					signal,
					...input
				}: { projectId: string; signal: AbortSignal } & Parameters<
					typeof session.readHyperframesExampleSource
				>[0]["input"]) => {
					signal.throwIfAborted();
					pages++;
					return session.readHyperframesExampleSource({
						input,
						host: async (effect) => {
							const plan = glue.hyperframesReferenceSource(effect.request);
							const text = await readFile(
								path.join(root, "resources/hyperframes", plan.relativePath),
								"utf8",
							);
							return {
								type: "success",
								data: glue.hyperframesReferenceSource(effect.request, text),
							};
						},
					});
				},
			},
		} as unknown as EditorCore;
		await importHyperframesExample({
			editor,
			projectId: "classic-project",
			id: candidate.id,
			upstreamCommit: catalog.upstreamCommit,
			signal: new AbortController().signal,
		});
		expect(committed).toBe(1);
		expect(pages).toBeGreaterThan(1);
		const imported = Object.values(
			session.read().document.hyperframesCompositions!,
		).find((item) => item.source.entryFile === candidate.prepared.entryFile)!;
		expect(imported.source.files[imported.source.entryFile]).toContain(
			"data-composition-id",
		);
		expect(Object.keys(imported.source.files).sort()).toEqual(
			candidate.prepared.files
				.map((file: { path: string }) => file.path)
				.sort(),
		);
		const before = session.read();
		const controller = new AbortController();
		controller.abort();
		await expect(
			importHyperframesExample({
				editor,
				projectId: "classic-project",
				id: candidate.id,
				upstreamCommit: catalog.upstreamCommit,
				signal: controller.signal,
			}),
		).rejects.toBeDefined();
		expect(committed).toBe(1);
		expect(session.read()).toEqual(before);
	} finally {
		session.dispose();
		commit = undefined;
	}
}, 30000);
