// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Pinned fixture manifests and actual Rust contracts. */
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
import { HyperframesCaptureSession } from "../capture-session";
import { HyperframesPreviewHost } from "../preview-host";
import type { HyperframesInspection, HyperframesSource } from "../types";

const digest = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");
type Inventory = {
	upstreamCommit: string;
	items: Array<{
		id: string;
		kind: string;
		sourcePath: string;
		files: Array<{ path: string; bytes: number; sha256: string }>;
		declaredFiles: Array<{ path: string }>;
		verification: { missingDeclaredFiles: string[] };
	}>;
};

/** Technical evidence only. Source/visual/prompt review and composed export are
 * separate gates: this runner never changes a catalog verification label. */
test.skipIf(process.env.OPENCUT_HYPERFRAMES_BATCH_TEST !== "1")(
	"bundled reference candidates render offline, seek deterministically, import and reopen",
	async () => {
		const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
		const resources = path.join(root, "resources/hyperframes");
		const catalog = JSON.parse(
			await readFile(path.join(resources, "catalog.json"), "utf8"),
		) as Inventory;
		const vendor = JSON.parse(
			await readFile(path.join(resources, "vendor/manifest.json"), "utf8"),
		) as {
			files: Array<{
				path: string;
				sourceUrl: string;
				bytes: number;
				sha256: string;
				replacement?: boolean;
			}>;
		};
		const reviews = JSON.parse(
			await readFile(path.join(resources, "review-exclusions.json"), "utf8"),
		) as { upstreamCommit: string; items: Record<string, string> };
		if (reviews.upstreamCommit !== catalog.upstreamCommit)
			throw new Error("Review generation differs");
		const dependencies = new Map<
			string,
			{ path: string; text: string; sha256: string }
		>();
		for (const file of vendor.files) {
			const bytes = await readFile(path.join(resources, "vendor", file.path));
			expect(bytes.length).toBe(file.bytes);
			expect(digest(bytes)).toBe(file.sha256);
			if (file.path.endsWith(".js") || file.replacement)
				dependencies.set(file.sourceUrl, {
					path: `__opencut_vendor/${file.path}`,
					text: bytes.toString("utf8"),
					sha256: file.sha256,
				});
		}
		const output = path.join(
			root,
			".local/hyperframes-examples-batch",
			catalog.upstreamCommit,
		);
		await mkdir(output, { recursive: true });
		const results: Array<Record<string, unknown>> = [];
		const excluded: Array<{ id: string; reason: string }> = [];
		const wanted = Number(process.env.OPENCUT_HYPERFRAMES_BATCH_LIMIT ?? 150);
		if (!Number.isInteger(wanted) || wanted < 1 || wanted > 394)
			throw new Error("Batch limit must be 1..394");
		const targets = {
			block: Math.ceil(wanted / 3),
			component: wanted - Math.ceil(wanted / 3),
		};
		const completed = { block: 0, component: 0 };
		const priorExclusions = new Map<string, string>();
		if (process.env.OPENCUT_HYPERFRAMES_BATCH_RESUME === "1") {
			const prior = JSON.parse(
				await readFile(path.join(output, "report.json"), "utf8"),
			);
			if (prior.upstreamCommit !== catalog.upstreamCommit)
				throw new Error("Cannot resume a different reference generation");
			for (const result of prior.results) {
				if (reviews.items[result.id]) continue;
				if (
					!catalog.items.some(
						(item) => item.id === result.id && item.kind === result.kind,
					)
				)
					throw new Error("Unknown resumed reference");
				const bytes = await readFile(
					path.join(output, result.id, "source.json"),
				);
				if (digest(bytes) !== result.sourceSha256)
					throw new Error("Resumed source evidence differs");
				for (const frame of result.frames)
					if (
						digest(await readFile(path.join(output, result.id, frame.file))) !==
						frame.sha256
					)
						throw new Error("Resumed frame evidence differs");
				results.push(result);
				if (result.kind === "block") completed.block++;
				else if (result.kind === "component") completed.component++;
			}
			for (const item of prior.excluded)
				priorExclusions.set(item.id, item.reason);
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
		const save = () =>
			writeFile(
				path.join(output, "report.json"),
				JSON.stringify(
					{
						upstreamCommit: catalog.upstreamCommit,
						targets,
						completed,
						results,
						excluded,
						verified: false,
						remaining: [
							"visual and prompt review",
							"composed export",
							"packaged delivery",
						],
					},
					null,
					2,
				),
			);
		for (const item of catalog.items) {
			if (item.kind !== "block" && item.kind !== "component") continue;
			if (reviews.items[item.id]) {
				excluded.push({ id: item.id, reason: reviews.items[item.id] });
				continue;
			}
			if (results.some((result) => result.id === item.id)) continue;
			if (completed[item.kind] >= targets[item.kind]) continue;
			const previousFailure = priorExclusions.get(item.id);
			if (
				previousFailure &&
				!previousFailure.includes("duration is unresolved") &&
				![...dependencies.keys()].some((url) => previousFailure.includes(url))
			) {
				excluded.push({ id: item.id, reason: previousFailure });
				continue;
			}
			const entryFile =
				item.kind === "component"
					? "demo.html"
					: item.declaredFiles.find((file) => file.path.endsWith(".html"))
							?.path;
			if (
				!entryFile ||
				!item.files.some((file) => file.path === entryFile) ||
				item.verification.missingDeclaredFiles.length
			) {
				excluded.push({
					id: item.id,
					reason: "Missing declared files or a complete demo entry",
				});
				continue;
			}
			if (
				item.files.some(
					(file) => !/\.(html|css|js|mjs|json|svg|md|txt)$/.test(file.path),
				)
			) {
				excluded.push({
					id: item.id,
					reason: "Binary dependency closure needs a separate resource pass",
				});
				continue;
			}
			const runtime = await createCanonicalTestRuntime();
			const state = await createCanonicalTestRuntime();
			const session = new CanonicalClassicSession({
				runtime: state,
				projectId: "classic-project",
			});
			const host = new HyperframesPreviewHost();
			let capture: HyperframesCaptureSession | null = null;
			try {
				const source: HyperframesSource = {
					entryFile,
					files: {},
					resourceAssetIds: {},
				};
				const replacements = new Set<string>();
				for (const file of item.files.filter((file) =>
					/\.(html|css|js|mjs|svg)$/.test(file.path),
				)) {
					const bytes = await readFile(
						path.join(resources, item.sourcePath, file.path),
					);
					if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
						throw new Error(`Upstream file integrity failed: ${file.path}`);
					let text = new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(bytes);
					for (const [url, dependency] of dependencies)
						if (text.includes(url)) {
							text = text.replaceAll(url, `/${dependency.path}`);
							replacements.add(url);
							source.files[dependency.path] = dependency.text;
						}
					source.files[file.path] = text;
				}
				const inspection = runtime.invokeSync(
					"hyperframes.project.inspect",
					{ source },
					null,
				).result.data as HyperframesInspection;
				const gaps = inspection.dependencies.filter(
					(dependency) =>
						dependency.status === "external" || dependency.status === "missing",
				);
				if (gaps.length) {
					excluded.push({
						id: item.id,
						reason: `Unclosed dependencies: ${gaps.map((gap) => gap.reference).join(", ")}`,
					});
					continue;
				}
				capture = await HyperframesCaptureSession.open({
					source,
					runtime,
					host,
					resources: new Map(),
					bundledOnly: true,
					signal: AbortSignal.timeout(90000),
				});
				const itemOutput = path.join(output, item.id);
				await mkdir(itemOutput, { recursive: true });
				const duration = capture.durationSeconds;
				const times = [
					duration * 0.15,
					duration * 0.5,
					duration * 0.85,
					duration * 0.5,
				];
				const frames: Array<{
					timeSeconds: number;
					sha256: string;
					file: string;
					transparentPixels: boolean;
				}> = [];
				for (const [index, timeSeconds] of times.entries()) {
					const artifact = await capture.capture({
						timeSeconds,
						previewScale: 0.5,
					});
					const bytes = runtime.readArtifact(artifact.uri);
					const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
					const alpha = pixels.filter((_, index) => index % 4 === 3);
					if (!alpha.some((value) => value > 0))
						throw new Error("Captured frame is completely transparent");
					const file = `frame-${index}.png`;
					await writeFile(path.join(itemOutput, file), bytes);
					frames.push({
						timeSeconds,
						sha256: digest(bytes),
						file,
						transparentPixels: alpha.some((value) => value < 255),
					});
				}
				if (frames[1].sha256 !== frames[3].sha256)
					throw new Error(
						"Returning to the same time produced a different frame",
					);
				if (capture.externalRequests.length)
					throw new Error(
						`Unbundled runtime requests: ${capture.externalRequests.join(", ")}`,
					);
				session.attach({ classic });
				const before = session.read();
				const imported = session.importHyperframes({
					name: item.id,
					source,
					resolvedDurationSeconds: duration,
					runtimeManifest: capture.runtimeManifest,
				});
				const after = session.read();
				expect(
					after.document.hyperframesCompositions![imported.assetId].source,
				).toEqual(source);
				session.undo();
				expect(session.read()).toEqual(before);
				session.redo();
				expect(session.read()).toEqual(after);
				const reopened = new CanonicalClassicSession({
					runtime: await createCanonicalTestRuntime(),
					projectId: "classic-project",
				});
				try {
					reopened.restore(session.archive());
					expect(reopened.read()).toEqual(after);
				} finally {
					reopened.dispose();
				}
				await writeFile(
					path.join(itemOutput, "source.json"),
					JSON.stringify(source),
				);
				results.push({
					id: item.id,
					kind: item.kind,
					upstreamCommit: catalog.upstreamCommit,
					sourceSha256: digest(JSON.stringify(source)),
					replacements: [...replacements],
					entryFile,
					durationSeconds: duration,
					frames,
					offline: true,
					import: true,
					reopen: true,
					deterministicSeek: true,
					verified: false,
				});
				completed[item.kind]++;
				console.log(
					`Reference evidence ${completed.block + completed.component}/${wanted}: ${item.id}`,
				);
			} catch (error) {
				excluded.push({ id: item.id, reason: String(error) });
			} finally {
				await capture?.close();
				await host.close();
				runtime.free();
				session.dispose();
				await save();
			}
			if (
				completed.block >= targets.block &&
				completed.component >= targets.component
			)
				break;
		}
		await save();
		expect(completed.block).toBeGreaterThanOrEqual(targets.block);
		expect(completed.component).toBeGreaterThanOrEqual(targets.component);
	},
	3600000,
);
