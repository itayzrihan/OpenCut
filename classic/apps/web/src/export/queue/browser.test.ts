// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser } from "@hyperframes/engine";
import type {
	browserRenderRequest,
	publishBrowserRender,
	readBrowserRenderSources,
} from "./browser";
import type { RenderJob, RenderQueueView } from "./types";
import type { CanonicalClassicSnapshot } from "@/core/canonical-classic-session";

declare global {
	interface Window {
		renderQueueFixture: {
			browserRenderRequest: typeof browserRenderRequest;
			publishBrowserRender: typeof publishBrowserRender;
			readBrowserRenderSources: typeof readBrowserRenderSources;
		};
	}
}
const repo = new URL("../../../../../../", import.meta.url);
const wasm = new URL("classic/rust/editor-runtime-wasm/pkg/", repo);
const glue = fileURLToPath(new URL("opencut_editor_runtime_wasm_bg.js", wasm));

test("hosted browser tabs share a durable held queue and save completed output locally", async () => {
	const bundle = await Bun.build({
		entrypoints: [fileURLToPath(new URL("./browser.ts", import.meta.url))],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "queue-browser-fixtures",
				setup(build) {
					build.onResolve(
						{ filter: /^@\/core\/load-canonical-runtime$/ },
						() => ({ path: "runtime", namespace: "fixture" }),
					);
					build.onResolve(
						{ filter: /^@\/services\/storage\/service$/ },
						() => ({ path: "media", namespace: "fixture" }),
					);
					build.onLoad({ filter: /^runtime$/, namespace: "fixture" }, () => ({
						loader: "js",
						contents: `import * as glue from ${JSON.stringify(glue)};
						let ready;
						export async function loadCanonicalRuntime() {
							ready ??= WebAssembly.instantiateStreaming(fetch("/runtime.wasm"), {"./opencut_editor_runtime_wasm_bg.js": glue})
								.then(({instance}) => { glue.__wbg_set_wasm(instance.exports); instance.exports.__wbindgen_start(); });
							await ready;
							return new glue.CanonicalEditorRuntime();
						}`,
					}));
					build.onLoad({ filter: /^media$/, namespace: "fixture" }, () => ({
						loader: "js",
						contents: `export const storageService = {
						loadMediaAsset: async ({projectId}) => ({bindingRevision: 3, file: new File([projectId], "source.mp4")}),
						loadProjectFont: async () => null,
					};`,
					}));
				},
			},
		],
	});
	if (!bundle.success) throw Error(bundle.logs.join("\n"));
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/runtime.wasm")
				return new Response(
					Bun.file(
						fileURLToPath(new URL("opencut_editor_runtime_wasm_bg.wasm", wasm)),
					),
					{ headers: { "Content-Type": "application/wasm" } },
				);
			if (path === "/fixture.js")
				return new Response(bundle.outputs[0], {
					headers: { "Content-Type": "text/javascript" },
				});
			return new Response("<html><body></body></html>", {
				headers: { "Content-Type": "text/html" },
			});
		},
	});
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	try {
		const page = await lease.browser.newPage();
		const worker = await lease.browser.newPage();
		await Promise.all(
			[page, worker].map(async (tab) => {
				await tab.goto(`http://localhost:${server.port}`);
				await tab.evaluate(async () => {
					window.__opencutAccountId = "fixture";
					window.__opencutHostedLegitate = true;
					const moduleUrl = "/fixture.js";
					window.renderQueueFixture = await import(moduleUrl);
				});
			}),
		);
		const snapshot = (await Bun.file(
			fileURLToPath(
				new URL("crates/editor-api/tests/fixtures/classic-project.json", repo),
			),
		).json()) as CanonicalClassicSnapshot;
		const jobs = ["project-one", "project-two", "project-later"].map(
			(projectId) => {
				const captured = structuredClone(snapshot);
				captured.document.metadata.id = projectId;
				return {
					action: "enqueue",
					id: crypto.randomUUID(),
					projectId,
					sceneId: "main-scene",
					sourceRevision: 7,
					snapshot: captured,
					options: {
						format: "mp4",
						quality: "high",
						preferences: { resolution: "project", encoding: "compatible" },
						fps: { numerator: 25, denominator: 1 },
						includeAudio: true,
					},
				};
			},
		);
		const submit = (index: number) =>
			page.evaluate(
				(job) => window.renderQueueFixture.browserRenderRequest(job),
				jobs[index]!,
			);
		const claim = () =>
			worker.evaluate(() =>
				window.renderQueueFixture.browserRenderRequest({
					action: "claim",
					attempt: crypto.randomUUID(),
				}),
			) as Promise<RenderJob | null>;
		await submit(0);
		await submit(1);
		expect(await claim()).toBeNull();
		await page.evaluate(() =>
			window.renderQueueFixture.browserRenderRequest({ action: "start" }),
		);
		const first = await claim();
		expect(first?.projectId).toBe("project-one");
		await submit(2);
		expect(await claim()).toBeNull();
		if (!first) throw Error("Missing first render");
		expect(
			await worker.evaluate(async (current) => {
				const files = await window.renderQueueFixture.readBrowserRenderSources(
					current.id,
				);
				return Object.values(files.media)[0]!.text();
			}, first),
		).toBe("project-one");
		await worker.evaluate(
			(current) =>
				window.renderQueueFixture.publishBrowserRender({
					job: current,
					file: new Blob(["first output"], { type: "video/mp4" }),
				}),
			first,
		);
		expect((await claim())?.projectId).toBe("project-two");
		const state = (await page.evaluate(() =>
			window.renderQueueFixture.browserRenderRequest(),
		)) as RenderQueueView;
		expect(state.jobs.map((job) => [job.status, job.released])).toEqual([
			["completed", true],
			["rendering", true],
			["queued", false],
		]);
		expect(state.jobs[0]?.outputId).toBe(jobs[0]?.id);
		await worker.evaluate(async () => {
			window.__opencutAccountId = "another-account";
		});
		expect(
			(
				(await worker.evaluate(() =>
					window.renderQueueFixture.browserRenderRequest(),
				)) as RenderQueueView
			).jobs,
		).toEqual([]);
	} finally {
		server.stop();
		await lease.release();
	}
}, 90000);
