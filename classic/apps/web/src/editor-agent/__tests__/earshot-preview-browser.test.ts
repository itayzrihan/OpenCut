import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser, releaseBrowser } from "@hyperframes/engine";

test("Earshot preview host synthesizes preset and custom source in the real opaque browser sandbox", async () => {
	const build = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("./earshot-preview-browser-fixture.ts", import.meta.url),
			),
		],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "source-alias",
				setup(b) {
					b.onResolve({ filter: /^@\// }, (args) => ({
						path: Bun.resolveSync(
							args.path,
							fileURLToPath(new URL("../../../", import.meta.url)),
						),
					}));
				},
			},
		],
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const script = await build.outputs[0].text();
	const assets = new URL("../../../public/earshot/runtime/", import.meta.url);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/fixture.js")
				return new Response(script, {
					headers: { "Content-Type": "text/javascript" },
				});
			const filename = pathname.replace("/earshot/runtime/", "");
			if (
				pathname.startsWith("/earshot/runtime/") &&
				/^[A-Za-z0-9_.-]+$/.test(filename)
			)
				return new Response(Bun.file(new URL(filename, assets)));
			return new Response(
				"<!doctype html><title>Isolated Earshot preview fixture</title>",
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	let lease: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
	try {
		lease = await acquireBrowser([], {
			enableBrowserPool: false,
			forceScreenshot: true,
		});
		const page = await lease.browser.newPage();
		await page.goto(`http://127.0.0.1:${server.port}`);
		for (const custom of [false, true]) {
			const result = await page.evaluate(
				async (custom) =>
					(await import(`${location.origin}/fixture.js`)).previewCodeSound(
						custom,
					),
				custom,
			);
			expect(result.bytes).toBe(4800 * result.channels * 2);
			expect(result.peak).toBeGreaterThan(0.01);
			expect(result.rms).toBeGreaterThan(0.001);
			expect(result.peak).toBeLessThanOrEqual(1);
		}
		expect(
			await page.evaluate(() => document.querySelectorAll("iframe").length),
		).toBe(0);
	} finally {
		if (lease)
			await releaseBrowser(lease.browser, { enableBrowserPool: false });
		server.stop(true);
	}
}, 180000);
