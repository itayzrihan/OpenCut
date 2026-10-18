// @opencut-test-wasm: real
import { test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser, releaseBrowser } from "@hyperframes/engine";

test.skipIf(process.env.OPENCUT_STREAM_EXPORT_TEST !== "1")(
	"real disk export, audio parity and ten-hour muxing",
	async () => {
		const wasmRoot = new URL("../../../../../rust/wasm/pkg/", import.meta.url);
		const build = async (path: string) => {
			const built = await Bun.build({
				entrypoints: [fileURLToPath(new URL(path, import.meta.url))],
				target: "browser",
				format: "esm",
				plugins: [
					{
						name: "real-wasm",
						setup(b) {
							b.onResolve({ filter: /^opencut-wasm$/ }, () => ({
								path: "/opencut_wasm_bg.js",
								external: true,
							}));
						},
					},
				],
			});
			if (!built.success) throw new Error(built.logs.join("\n"));
			return (await built.outputs[0].text()).replaceAll(
				'"opencut-wasm"',
				'"/opencut_wasm_bg.js"',
			);
		};
		const script = await build("./streaming-fixture.ts"),
			worker = await build("../../media/noise-reduction.worker.ts");
		const boot = `const glue = await import('/opencut_wasm_bg.js');const {instance}=await WebAssembly.instantiate(await(await fetch('/opencut_wasm_bg.wasm')).arrayBuffer(),{'./opencut_wasm_bg.js':glue});glue.__wbg_set_wasm(instance.exports);instance.exports.__wbindgen_start();`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const p = new URL(req.url).pathname;
				if (p.endsWith("opencut_wasm_bg.js"))
					return new Response(
						Bun.file(new URL("opencut_wasm_bg.js", wasmRoot)),
						{ headers: { "Content-Type": "text/javascript" } },
					);
				if (p.endsWith("opencut_wasm_bg.wasm"))
					return new Response(
						Bun.file(new URL("opencut_wasm_bg.wasm", wasmRoot)),
						{ headers: { "Content-Type": "application/wasm" } },
					);
				if (p.endsWith("noise-reduction.worker.ts"))
					return new Response(
						"const queued=[]; self.onmessage=e=>queued.push(e);\n" +
							boot +
							"\n" +
							worker +
							"\nfor(const e of queued) self.onmessage(e);",
						{
							headers: { "Content-Type": "text/javascript" },
						},
					);
				if (p === "/fixture.js")
					return new Response(script, {
						headers: { "Content-Type": "text/javascript" },
					});
				return new Response(
					"<!doctype html><title>Isolated export test</title>",
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
		let lease: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
		try {
			lease = await acquireBrowser(
				["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
				{ enableBrowserPool: false, forceScreenshot: true },
			);
			const page = await lease.browser.newPage();
			page.on("console", (message) => console.log("browser:", message.text()));
			page.on("pageerror", (error) => console.error("browser error:", error));
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.evaluate(`(async () => { ${boot} })()`);
			const pitch = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).pitchParity(),
			);
			console.log("pitch parity", JSON.stringify(pitch));
			for (const row of pitch) {
				expect(row.error).toBeLessThan(0.00001);
				expect(row.oldFirst).toBe(row.newFirst);
				expect(row.oldTail).toBe(row.newTail);
			}

			const parity = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).audioParity(),
			);
			console.log("audio parity", JSON.stringify(parity));
			for (const row of parity) {
				expect(row.length).toBe(row.expected);
				expect(row.maxWindow).toBeLessThanOrEqual(88200);
				expect(row.peak).toBeLessThanOrEqual(0.980001);
				// Independent Web Audio resamplers and nonlinear denoising are not bit-identical.
				expect(row.rms).toBeLessThan(0.003);
				expect(row.seam).toBeLessThan(0.02);
			}
			const disk = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).diskAndVideo(),
			);
			console.log("disk and video", JSON.stringify(disk));
			expect(disk.info.duration).toBeCloseTo(4, 4);
			expect(disk.info.packetCount).toBe(100);
			expect(disk.info.progress.at(-1)).toBe(1);
			expect(disk.sparse.size).toBe(10 * 3600 * 44100 * 8);
			expect(disk.sparse.tail[0]).toBe(0);
			expect(disk.sparse.tail[6]).toBeCloseTo(0.5);
			const colors = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).cutSnapshots(),
			);
			expect(colors[0][0]).toBeGreaterThan(180);
			expect(colors[0][2]).toBeLessThan(40);
			for (const color of colors.slice(1)) {
				expect(color[2]).toBeGreaterThan(180);
				expect(color[0]).toBeLessThan(40);
			}
			const long = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).longMux(),
			);
			console.log("ten-hour mux", JSON.stringify(long));
			expect(long.duration).toBe(36000);
			expect(long.packets).toBe(36000);
		} finally {
			if (lease)
				await releaseBrowser(lease.browser, { enableBrowserPool: false });
			server.stop(true);
		}
	},
	240000,
);
