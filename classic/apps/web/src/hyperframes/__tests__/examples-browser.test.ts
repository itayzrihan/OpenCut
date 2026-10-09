// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Integration reads the pinned public catalog and actual Rust/WASM contracts. */
import { expect, test } from "bun:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesRenderHost } from "../render-host";
import type { HyperframesSource } from "../types";

// This is a real renderer/import/reopen pilot. It deliberately does not promote
// catalog entries to verified: external dependencies and prompts need review.
test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TEST !== "1")(
	"pinned references render, import and reopen through the actual Classic runtime",
	async () => {
		const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
		const catalog = JSON.parse(
			await readFile(
				path.join(root, "resources/hyperframes/catalog.json"),
				"utf8",
			),
		) as {
			upstreamCommit: string;
			items: Array<{
				id: string;
				kind: string;
				sourcePath: string;
				files: Array<{ path: string; sha256: string }>;
				declaredFiles: Array<{ path: string; type: string }>;
			}>;
		};
		const output = path.join(
			root,
			".local/hyperframes-examples-pilot",
			catalog.upstreamCommit,
		);
		await mkdir(output, { recursive: true });
		const results: unknown[] = [];
		for (const id of [
			"data-chart",
			"lt-clean-bar",
			"logo-outro",
			"grain-overlay",
			"vignette",
		]) {
			const item = catalog.items.find((item) => item.id === id)!;
			expect(item).toBeDefined();
			const source: HyperframesSource = {
				entryFile: "",
				files: {},
				resourceAssetIds: {},
			};
			for (const file of item.files.filter((file) =>
				/\.(html|css|js|mjs|json|svg)$/.test(file.path),
			)) {
				const bytes = await readFile(
					path.join(root, "resources/hyperframes", item.sourcePath, file.path),
				);
				expect(createHash("sha256").update(bytes).digest("hex")).toBe(
					file.sha256,
				);
				source.files[file.path] = new TextDecoder("utf-8", {
					fatal: true,
				}).decode(bytes);
			}
			const primary = item.declaredFiles.find((file) =>
				file.path.endsWith(".html"),
			)!;
			if (item.kind === "component") {
				source.entryFile = "opencut-demo.html";
				source.files[source.entryFile] =
					`<!doctype html><html><head><style>html,body{margin:0;background:transparent}#demo{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><div id="demo" data-composition-id="demo" data-no-timeline data-width="640" data-height="360" data-duration="4">${source.files[primary.path]}</div></body></html>`;
			} else source.entryFile = primary.path;
			const runtime = await createCanonicalTestRuntime();
			const state = await createCanonicalTestRuntime();
			const session = new CanonicalClassicSession({
				runtime: state,
				projectId: "classic-project",
			});
			const host = new HyperframesRenderHost(runtime);
			const scope = {
				accountId: "catalog-pilot",
				projectId: "classic-project",
			};
			try {
				const opened = await host.open({
					scope,
					source,
					resolveResource: async () => null,
					signal: AbortSignal.timeout(90000),
				});
				const frames = [];
				for (const timeSeconds of [
					0.5,
					Math.min(2, opened.durationSeconds / 2),
				]) {
					const artifact = await host.capture({
						scope,
						id: opened.id,
						timeSeconds,
					});
					const bytes = runtime.readArtifact(artifact.uri);
					const decoded = await sharp(bytes)
						.ensureAlpha()
						.raw()
						.toBuffer({ resolveWithObject: true });
					const alpha = decoded.data.filter((_, index) => index % 4 === 3);
					expect(alpha.some((value) => value > 0)).toBe(true);
					const name = `${id}-${timeSeconds}.png`;
					await writeFile(path.join(output, name), bytes);
					frames.push({
						timeSeconds,
						file: name,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						hasTransparentPixels: alpha.some((value) => value < 255),
					});
				}
				const classic = JSON.parse(
					await readFile(
						path.join(
							root,
							"crates/editor-api/tests/fixtures/classic-project.json",
						),
						"utf8",
					),
				) as CanonicalClassicSnapshot;
				session.attach({ classic });
				const before = session.read();
				const imported = session.importHyperframes({
					name: id,
					source,
					runtimeManifest: opened.runtimeManifest,
				});
				const after = session.read();
				expect(
					after.document.hyperframesCompositions![imported.assetId].source,
				).toEqual(source);
				session.undo();
				expect(session.read()).toEqual(before);
				session.redo();
				expect(session.read()).toEqual(after);
				const reopenedRuntime = await createCanonicalTestRuntime();
				const reopened = new CanonicalClassicSession({
					runtime: reopenedRuntime,
					projectId: "classic-project",
				});
				try {
					reopened.restore(session.archive());
					expect(reopened.read()).toEqual(after);
				} finally {
					reopened.dispose();
				}
				results.push({
					id,
					kind: item.kind,
					preview: true,
					import: true,
					reopen: true,
					frames,
					verified: false,
					remaining: [
						"dependency closure",
						"prompt and visual review",
						"mixed export",
					],
				});
				await host.closeSession({ scope, id: opened.id });
			} finally {
				await host.close();
				runtime.free();
				session.dispose();
			}
			await writeFile(
				path.join(output, "report.json"),
				JSON.stringify(
					{ upstreamCommit: catalog.upstreamCommit, results },
					null,
					2,
				),
			);
		}
	},
	600000,
);
