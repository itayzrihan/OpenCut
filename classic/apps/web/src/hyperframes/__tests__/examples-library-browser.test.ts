// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test-only browser-to-real-runtime protocol. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { acquireBrowser } from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";

for (const presentation of ["dialog", "page"] as const) {
	test(`the examples ${presentation} searches, filters and reads real pinned source through the canonical registry`, async () => {
		const require = createRequire(import.meta.url);
		const bundle = await Bun.build({
			entrypoints: [
				fileURLToPath(
					new URL("./examples-library-fixture.tsx", import.meta.url),
				),
			],
			target: "browser",
			format: "esm",
			plugins: [
				{
					name: "test-editor-transport",
					setup(build) {
						build.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path }) => ({
							path: require.resolve(path),
						}));
						build.onResolve({ filter: /^\.\/import-example$/ }, () => ({
							path: "import",
							namespace: "fixture-import",
						}));
						build.onLoad({ filter: /.*/, namespace: "fixture-import" }, () => ({
							loader: "js",
							contents:
								'export async function importHyperframesExample(){throw new Error("Import IO is exercised by its separate acceptance suite");}',
						}));
						build.onResolve({ filter: /^@\/editor\/use-editor$/ }, () => ({
							path: "host",
							namespace: "fixture",
						}));
						build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
							loader: "js",
							contents: `const command={searchHyperframesExamples:input=>window.hfReferenceCall("search",input),readHyperframesExample:input=>window.hfReferenceCall("read",input),readHyperframesExampleSource:({signal,...input})=>window.hfReferenceCall("source",input)};const editor={command};export const useEditor=()=>editor;`,
						}));
					},
				},
			],
		});
		if (!bundle.success) throw new Error(bundle.logs.join("\n"));
		const runtime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime,
			projectId: "classic-project",
		});
		const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
		const glue =
			await import("../../../../../rust/editor-runtime-wasm/pkg/opencut_editor_runtime_wasm_bg.js");
		const lease = await acquireBrowser(["--disable-gpu"], {
			enableBrowserPool: false,
			forceScreenshot: true,
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
			const before = session.read();
			const page = await lease.browser.newPage();
			const localCatalog = JSON.parse(
				await readFile(
					join(root, "resources/hyperframes/catalog.json"),
					"utf8",
				),
			);
			const previewFiles = new Map<string, string>();
			for (const item of localCatalog.items) {
				for (const frame of item.prepared?.evidence.frames ?? []) {
					previewFiles.set(
						`/hyperframes-reference-previews/${frame.sha256}.png`,
						join(
							root,
							"resources/hyperframes",
							item.prepared.sourcePath,
							frame.file,
						),
					);
				}
			}
			await page.setRequestInterception(true);
			page.on("request", async (request) => {
				if (!request.url().startsWith("http")) {
					await request.continue();
					return;
				}
				const url = new URL(request.url());
				const file =
					url.origin === "https://reference-test.local"
						? previewFiles.get(url.pathname)
						: undefined;
				if (file)
					await request.respond({
						status: 200,
						contentType: "image/png",
						body: await readFile(file),
					});
				else await request.abort();
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.exposeFunction(
				"hfReferenceCall",
				async (operation: string, input: Record<string, unknown>) => {
					const {
						projectId: _projectId,
						semantic: _semantic,
						signal: _signal,
						...value
					} = input;
					if (operation === "search")
						return session.searchHyperframesExamples(
							value as Parameters<typeof session.searchHyperframesExamples>[0],
						);
					if (operation === "read")
						return session.readHyperframesExample(
							value as Parameters<typeof session.readHyperframesExample>[0],
						);
					return session.readHyperframesExampleSource({
						input: value as Parameters<
							typeof session.readHyperframesExampleSource
						>[0]["input"],
						host: async (effect) => {
							const plan = glue.hyperframesReferenceSource(effect.request);
							const source = await readFile(
								join(root, "resources/hyperframes", plan.relativePath),
								"utf8",
							);
							return {
								type: "success",
								data: glue.hyperframesReferenceSource(effect.request, source),
							};
						},
					});
				},
			);
			await page.setViewport({ width: 1280, height: 900 });
			await page.setContent(
				'<base href="https://reference-test.local/"><div id="examples"></div>',
			);
			await page.evaluate(
				async ({ code, presentation }) => {
					const url = URL.createObjectURL(
						new Blob([code], { type: "text/javascript" }),
					);
					try {
						(await import(url)).mount(presentation);
					} finally {
						URL.revokeObjectURL(url);
					}
				},
				{ code: await bundle.outputs[0].text(), presentation },
			);
			await page.waitForFunction(() =>
				document.body.textContent?.includes("394 captured"),
			);
			expect((await page.$('[role="dialog"]')) !== null).toBe(
				presentation === "dialog",
			);
			if (presentation === "page") {
				expect(
					await page.$('section[aria-label="HyperFrames examples library"]'),
				).not.toBeNull();
				expect(await page.$eval("h1", (el) => el.textContent)).toContain(
					"HyperFrames",
				);
			}
			await page.type(
				'input[aria-label="Search HyperFrames examples"]',
				"lt-clean-bar",
			);
			await page.waitForFunction(() =>
				document.body.textContent?.includes("1 matches"),
			);
			await page.click('button[aria-pressed="false"]');
			await page.waitForFunction(() =>
				document.body.textContent?.includes("Source file"),
			);
			await page.waitForFunction(() => {
				const frames = [
					...document.querySelectorAll<HTMLImageElement>(
						'img[src*="hyperframes-reference-previews"]',
					),
				];
				return (
					frames.length === 3 &&
					frames.every((frame) => frame.complete && frame.naturalWidth > 0)
				);
			});
			await page.select("label select", "lt-clean-bar.html");
			await page.waitForFunction(() =>
				document.querySelector('pre[dir="ltr"]')?.textContent?.includes("gsap"),
			);
			expect(
				await page.$eval('pre[dir="ltr"]', (element) => element.textContent),
			).toContain("<!doctype html>");
			await page.click('input[aria-label="Search HyperFrames examples"]');
			await page.keyboard.down("Control");
			await page.keyboard.press("A");
			await page.keyboard.up("Control");
			await page.keyboard.press("Backspace");
			await page.type(
				'input[aria-label="Search HyperFrames examples"]',
				"matrix-decode",
			);
			await page.waitForFunction(
				() =>
					document.querySelector<HTMLInputElement>(
						'input[aria-label="Search HyperFrames examples"]',
					)?.value === "matrix-decode" &&
					document.body.textContent?.includes("Excluded after review"),
			);
			await page.click('input[type="checkbox"]');
			await page.waitForFunction(() =>
				document.body.textContent?.includes("No matching references"),
			);
			expect(errors).toEqual([]);
			expect(session.read()).toEqual(before);
			await page.close();
		} finally {
			await lease.release();
			session.dispose();
		}
	}, 90000);
}
