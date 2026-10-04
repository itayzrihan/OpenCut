/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Browser fixture controls use small integer timeline ticks. */
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	acquireBrowser,
	buildChromeArgs,
	releaseBrowser,
} from "@hyperframes/engine";
import type { Bookmark } from "@/timeline/types";
import type {} from "./overlay-store-fixture";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"bookmark notes update on interval changes without rerendering the preview at every transport tick",
	async () => {
		const fixturePath = fileURLToPath(
			new URL("./overlay-store-fixture.tsx", import.meta.url),
		).replaceAll("\\", "/");
		const built = await Bun.build({
			entrypoints: [
				fileURLToPath(
					new URL("./overlay-browser-fixture.tsx", import.meta.url),
				),
			],
			target: "browser",
			format: "iife",
			define: { "process.env.NODE_ENV": '"development"' },
			plugins: [
				{
					name: "isolated-preview-boundaries",
					setup(build) {
						// Windows junctions can resolve the same React package with different
						// drive/path casing. Keep its hook dispatcher shared with React DOM.
						build.onResolve(
							{ filter: /^react($|\/)|^react-dom($|\/)/ },
							({ path }) => ({
								path: fileURLToPath(import.meta.resolve(path)),
								namespace: "file",
							}),
						);
						build.onResolve(
							{
								filter:
									/^@\/(core|wasm|guides|preview\/(components|preview-store)|parallax-story-teller\/(preview-overlay|camera-man-store))$/,
							},
							() => ({ path: fixturePath, namespace: "file" }),
						);
					},
				},
			],
		});
		expect(built.success).toBe(true);
		const script = await built.outputs[0].text();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname === "/fixture.js"
					? new Response(script, {
							headers: { "Content-Type": "text/javascript" },
						})
					: new Response(
							'<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
							{ headers: { "Content-Type": "text/html" } },
						);
			},
		});
		let acquired: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
		try {
			acquired = await acquireBrowser(
				buildChromeArgs(
					{ width: 640, height: 360 },
					{ browserGpuMode: "software" },
				),
				{ enableBrowserPool: false },
			);
			const { browser } = acquired;
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.waitForFunction(() => !!window.overlayFixture);
			const read = () => page.evaluate(() => window.overlayFixture.read());
			const tick = (next: number) =>
				page.evaluate((next) => window.overlayFixture.setTime({ next }), next);
			const initial = await read();
			expect(errors).toEqual([]);
			expect(initial.renders).toBe(1);
			for (const time of [1, 2, 10, 99]) await tick(time);
			expect((await read()).renders).toBe(initial.renders);
			const bookmarks = [
				{ time: 100, duration: 100, note: "Long note" },
				{ time: 150, duration: 20, note: "Overlap" },
				{ time: 50, duration: 400, note: " " },
				{ time: 220, note: "Point" },
			] as Bookmark[];
			await page.evaluate(
				(bookmarks) => window.overlayFixture.setBookmarks(bookmarks),
				bookmarks,
			);
			await tick(100);
			const first = await read();
			expect(first.notes).toBe("Long note");
			for (const time of [101, 110, 149]) await tick(time);
			expect((await read()).renders).toBe(first.renders);
			await tick(150);
			const overlap = await read();
			expect(overlap.notes).toBe("Long noteOverlap");
			await tick(170);
			expect((await read()).renders).toBe(overlap.renders);
			await tick(171);
			expect((await read()).notes).toBe("Long note");
			await tick(200);
			expect((await read()).notes).toBe("Long note");
			await tick(201);
			expect((await read()).notes).toBe("");
			await tick(220);
			expect((await read()).notes).toBe("Point");
			await tick(221);
			expect((await read()).notes).toBe("");
			await page.evaluate(() =>
				window.overlayFixture.setTime({ next: 155, seek: true }),
			);
			expect((await read()).notes).toBe("Long noteOverlap");
			await page.evaluate(() => window.overlayFixture.setVisible(false));
			const hidden = await read();
			expect(hidden.notes).toBe("");
			for (const time of [156, 175, 210]) await tick(time);
			expect((await read()).renders).toBe(hidden.renders);
			await tick(175);
			await page.evaluate(() => window.overlayFixture.setVisible(true));
			expect((await read()).notes).toBe("Long note");
			await page.evaluate(
				(bookmarks) => window.overlayFixture.setBookmarks(bookmarks),
				[
					{ time: 100, duration: 100, note: "Edited", color: "red" },
				] as Bookmark[],
			);
			expect((await read()).notes).toBe("Edited");
			expect(
				await page.$eval(
					'[aria-live="polite"] > div',
					(node) => (node as HTMLElement).style.borderLeft,
				),
			).toContain("red");
			await page.evaluate(() => window.overlayFixture.setBookmarks([]));
			expect((await read()).notes).toBe("");
			await page.evaluate(() => window.overlayFixture.setParallax(true));
			await tick(180);
			expect((await read()).camera).toBe("180");
			await tick(181);
			expect((await read()).camera).toBe("181");
			expect(errors).toEqual([]);
		} finally {
			try {
				if (acquired)
					await releaseBrowser(acquired.browser, { enableBrowserPool: false });
			} finally {
				await server.stop(true);
			}
		}
	},
	30_000,
);
