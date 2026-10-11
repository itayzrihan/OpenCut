// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test-only browser-to-real-runtime protocol. */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { acquireBrowser } from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesPreviewHost } from "../preview-host";
import { loadCatalogPreviewPackage } from "../catalog-preview-server";
import { CanonicalClassicSession } from "@/core/canonical-classic-session";

type PreviewWindow = Window & { __player?: { getTime(): number } };
let fixtureBundle: Awaited<ReturnType<typeof Bun.build>> | undefined;

for (const presentation of ["dialog", "page", "panel"] as const) {
	test(`the examples ${presentation} searches, filters and reads real pinned source through the canonical registry`, async () => {
		const require = createRequire(import.meta.url);
		const bundle = (fixtureBundle ??= await Bun.build({
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
							contents: `const command={searchHyperframesExamples:input=>window.hfReferenceCall("search",input),readHyperframesExample:input=>window.hfReferenceCall("read",input),readHyperframesExampleSource:({signal,...input})=>window.hfReferenceCall("source",input)};const editor={command};export const useEditor=()=>editor;export const useEditorProject=selector=>selector({project:{getActive:()=>({metadata:{id:"classic-project"}})}});`,
						}));
					},
				},
			],
		}));
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
		const previewHost = new HyperframesPreviewHost();
		let previewCreated = 0;
		let previewReleased: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			previewReleased = resolve;
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
				if (url.hostname.endsWith(".localhost")) {
					await request.continue();
					return;
				}
				if (url.pathname === "/api/editor-agent/hyperframes-catalog-preview") {
					if (request.method() === "OPTIONS") {
						await request.respond({
							status: 204,
							headers: {
								"Access-Control-Allow-Origin": "*",
								"Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
								"Access-Control-Allow-Headers": "content-type",
							},
						});
						return;
					}
					if (request.method() === "DELETE") {
						previewHost.remove({ id: url.searchParams.get("id")! });
						previewReleased();
						await request.respond({
							status: 204,
							headers: { "Access-Control-Allow-Origin": "*" },
						});
						return;
					}
					const input = JSON.parse(request.postData()!);
					const plan = runtime.invokeSync(
						"hyperframes.examples.preview.plan",
						input,
						null,
					).result.data;
					const prepared = await loadCatalogPreviewPackage({
						input: plan,
						directory: join(root, "resources/hyperframes"),
					});
					const lease = await previewHost.add(prepared);
					previewCreated++;
					await request.respond({
						status: 200,
						contentType: "application/json",
						headers: { "Access-Control-Allow-Origin": "*" },
						body: JSON.stringify({
							...lease,
							width: prepared.plan.width,
							height: prepared.plan.height,
						}),
					});
					return;
				}
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
			if (presentation === "panel") {
				await page.waitForSelector('button[aria-label="Catalog"]');
				await page.click('button[aria-label="Catalog"]');
				const { default: postcss } = await import("postcss");
				const { default: tailwind } = await import("@tailwindcss/postcss");
				const cssPath = join(root, "classic/apps/web/src/app/globals.css");
				await page.addStyleTag({
					content: (
						await postcss([tailwind()]).process(
							await readFile(cssPath, "utf8"),
							{ from: cssPath },
						)
					).css,
				});
				await page.evaluate(() =>
					document.documentElement.classList.add("dark"),
				);
			}
			await page.waitForFunction(() =>
				document.body.textContent?.includes("454 captured"),
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
			await page.hover('button[aria-pressed="false"]');
			await page.waitForSelector('iframe[title$="live preview"]');
			if (presentation === "panel") {
				expect(await page.$("[data-catalog-card] iframe")).not.toBeNull();
				expect(await page.$("aside")).toBeNull();
			}
			await page.click('button[aria-pressed="false"]');
			await page.waitForFunction(() =>
				document.body.textContent?.includes("Source file"),
			);
			await page.waitForSelector('iframe[title$="live preview"]');
			await page.waitForFunction(
				() => !document.body.textContent?.includes("Loading live source…"),
			);
			const live = page
				.frames()
				.find((frame) => frame.url().includes(".localhost"))!;
			await live.waitForFunction(
				() => ((window as PreviewWindow).__player?.getTime() ?? 0) > 0.2,
			);
			const first = await live.evaluate(() =>
				(window as PreviewWindow).__player!.getTime(),
			);
			await live.waitForFunction(
				(first: number) =>
					(window as PreviewWindow).__player!.getTime() > first + 0.2,
				{},
				first,
			);
			expect(await page.$("video")).toBeNull();
			expect(previewCreated).toBe(presentation === "panel" ? 2 : 1);
			await page.select("label select", "lt-clean-bar.html");
			await page.waitForFunction(() =>
				document.querySelector('pre[dir="ltr"]')?.textContent?.includes("gsap"),
			);
			expect(
				await page.$eval('pre[dir="ltr"]', (element) => element.textContent),
			).toContain("<!doctype html>");
			if (presentation === "panel") {
				expect(
					await page.$eval(
						'[data-testid="assets-panel"]',
						(el) => el.scrollWidth <= el.clientWidth,
					),
				).toBe(true);
				await page.click("aside button");
			}
			await page.click('input[aria-label="Search HyperFrames examples"]');
			await page.$eval(
				'input[aria-label="Search HyperFrames examples"]',
				(node) => (node as HTMLInputElement).select(),
			);
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
			if (presentation === "page" && process.env.OPENCUT_CATALOG_SCREENSHOT) {
				const { default: postcss } = await import("postcss");
				const { default: tailwind } = await import("@tailwindcss/postcss");
				const cssPath = join(root, "classic/apps/web/src/app/globals.css");
				const css = (
					await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), {
						from: cssPath,
					})
				).css;
				await page.addStyleTag({ content: css });
				await page.evaluate(() => {
					document.documentElement.classList.add("dark");
					document.body.style.cssText =
						"height:100vh;background:var(--background);color:var(--foreground)";
					document.getElementById("examples")!.style.height = "100vh";
				});
				await page.click('input[type="checkbox"]');
				await page.$eval(
					'input[aria-label="Search HyperFrames examples"]',
					(node) => (node as HTMLInputElement).select(),
				);
				await page.keyboard.press("Backspace");
				await page.waitForFunction(() =>
					document.body.textContent?.includes("454 matches"),
				);
				await page.screenshot({ path: process.env.OPENCUT_CATALOG_SCREENSHOT });
			}
			expect(errors).toEqual([]);
			expect(session.read()).toEqual(before);
			if (presentation === "page") {
				await page.$eval("button", (node) => {
					if (node.textContent === "Back to editor") node.click();
				});
			} else if (presentation === "panel") {
				await page.click('button[aria-label="Sounds"]');
				await page.waitForFunction(() =>
					document.body.textContent?.includes("Selected tab: sounds"),
				);
				expect(await page.$("iframe")).toBeNull();
				await page.click('button[aria-label="Catalog"]');
				await page.waitForFunction(() =>
					document.body.textContent?.includes("454 captured"),
				);
				expect(await page.$("iframe")).toBeNull();
				if (process.env.OPENCUT_CATALOG_PANEL_SCREENSHOT) {
					await page.setViewport({ width: 400, height: 740 });
					await page.hover('[data-catalog-card="animated-bar-chart"] button');
					await page.waitForSelector("[data-catalog-card] iframe");
					await page.waitForFunction(
						() => !document.body.textContent?.includes("Loading live source…"),
					);
					expect(await page.$('[data-catalog-card] [role="alert"]')).toBeNull();
					await page.screenshot({
						path: process.env.OPENCUT_CATALOG_PANEL_SCREENSHOT,
					});
					await page.click('button[aria-label="Sounds"]');
				}
			} else {
				await page.keyboard.press("Escape");
			}
			await released;
			await page.close();
		} finally {
			await previewHost.close();
			await lease.release();
			session.dispose();
		}
	}, 90000);
}
