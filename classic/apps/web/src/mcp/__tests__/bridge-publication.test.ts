import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	acquireBrowser,
	buildChromeArgs,
	releaseBrowser,
} from "@hyperframes/engine";
import type {} from "./bridge-browser-fixture";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"export progress keeps the MCP document snapshot stable while edits and heartbeats still publish",
	async () => {
		const fixture = fileURLToPath(
			new URL("./bridge-browser-fixture.tsx", import.meta.url),
		).replaceAll("\\", "/");
		const built = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL("./bridge-browser-entry.tsx", import.meta.url)),
			],
			target: "browser",
			format: "iife",
			define: { "process.env.NODE_ENV": '"development"' },
			plugins: [
				{
					name: "bridge-host-boundaries",
					setup(build) {
						build.onResolve(
							{ filter: /^react($|\/)|^react-dom($|\/)|^zod$/ },
							({ path }) => ({
								path: fileURLToPath(import.meta.resolve(path)),
								namespace: "file",
							}),
						);
						build.onResolve(
							{ filter: /^@\/|^\.\/bridge-browser-fixture$/ },
							() => ({ path: fixture, namespace: "file" }),
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
					{ width: 640, height: 360, captureMode: "screenshot" },
					{ browserGpuMode: "software" },
				),
				{ enableBrowserPool: false },
			);
			const page = await acquired.browser.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			await page.goto(`http://127.0.0.1:${server.port}`, {
				waitUntil: "domcontentloaded",
				timeout: 10_000,
			});
			await page.waitForFunction(() => !!window.bridgeFixture, {
				timeout: 5_000,
			});
			const advance = (ms: number) =>
				page.evaluate((ms) => window.bridgeFixture.advance(ms), ms);
			const read = () => page.evaluate(() => window.bridgeFixture.read());
			await advance(200);
			const before = await read();
			expect(before.documentBuilds).toBe(1);
			for (let frame = 0; frame < 5; frame++) {
				await page.evaluate(() => window.bridgeFixture.exportProgress());
				await advance(160);
			}
			const after = await read();
			expect(after.documentBuilds).toBe(before.documentBuilds);
			expect(after.publications).toEqual(before.publications);
			await advance(1_200);
			const heartbeat = await read();
			expect(heartbeat.publications.length).toBe(
				before.publications.length + 1,
			);
			expect(heartbeat.publications.at(-1)?.revision).toBe(
				before.publications.at(-1)?.revision,
			);
			expect(heartbeat.documentBuilds).toBe(1);
			await page.evaluate(() => window.bridgeFixture.rename());
			await advance(160);
			expect((await read()).publications.at(-1)?.projectName).toBe(
				"Renamed project",
			);
			await page.evaluate(() => window.bridgeFixture.settings());
			await advance(160);
			expect((await read()).publications.at(-1)?.timeline.settings.width).toBe(
				1280,
			);
			await page.evaluate(() => window.bridgeFixture.timelineEdit());
			await advance(160);
			expect((await read()).publications.at(-1)?.timeline.scene.title).toBe(
				"Edited title",
			);
			await page.evaluate(() => window.bridgeFixture.changeScene());
			await advance(160);
			expect((await read()).publications.at(-1)?.timeline.scene.id).toBe(
				"second-scene",
			);
			const edited = await read();
			expect(edited.publications.at(-1)!.revision).toBeGreaterThan(
				before.publications.at(-1)!.revision,
			);
			await page.evaluate(() => {
				window.bridgeFixture.seek();
				window.bridgeFixture.select();
			});
			await advance(160);
			const stateOnly = await read();
			expect(stateOnly.documentBuilds).toBe(edited.documentBuilds);
			expect(stateOnly.publications.at(-1)?.playback.positionSeconds).toBe(17);
			expect(stateOnly.publications.at(-1)?.selection).toBe("clip");
			await page.evaluate(() => window.bridgeFixture.closeProject());
			await advance(160);
			expect((await read()).publications.length).toBe(
				stateOnly.publications.length,
			);
			await page.evaluate(() => window.bridgeFixture.switchProject());
			await advance(160);
			const switched = await read();
			expect(switched.publications.at(-1)?.projectId).toBe("second");
			expect(switched.publications.at(-1)?.timeline.settings.width).toBe(640);
			await page.evaluate(() => window.bridgeFixture.unmount());
			await advance(5_000);
			const stopped = await read();
			expect(stopped.publications.length).toBe(switched.publications.length);
			expect(stopped.listeners).toBe(0);
			expect(stopped.deletes).toBe(1);
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
