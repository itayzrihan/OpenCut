// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser, releaseBrowser } from "@hyperframes/engine";

test.skipIf(process.env.OPENCUT_EARSHOT_EXPORT_TEST !== "1")(
	"code audio exports through PCM staging and a decodable MP4 with split, trim, retime, gain and failure parity",
	async () => {
		const wasmRoot = new URL("../../../../../rust/wasm/pkg/", import.meta.url);
		const sourceFixture = fileURLToPath(
			new URL("./export-pcm-source-fixture.ts", import.meta.url),
		);
		const build = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL("./export-pcm-fixture.ts", import.meta.url)),
			],
			target: "browser",
			format: "esm",
			plugins: [
				{
					name: "isolated-code-audio",
					setup(b) {
						b.onResolve({ filter: /^@\// }, (args) => ({
							path: Bun.resolveSync(
								args.path,
								fileURLToPath(new URL("../../../", import.meta.url)),
							),
						}));
						b.onResolve({ filter: /^opencut-wasm$/ }, () => ({
							path: "/opencut_wasm_bg.js",
							external: true,
						}));
						b.onResolve({ filter: /^\.\/render$/ }, (args) =>
							args.importer.endsWith("/earshot/audio.ts")
								? { path: sourceFixture }
								: undefined,
						);
					},
				},
			],
		});
		if (!build.success) throw new Error(build.logs.join("\n"));
		const script = (await build.outputs[0].text()).replaceAll(
			'"opencut-wasm"',
			'"/opencut_wasm_bg.js"',
		);
		const boot = `const glue = await import('/opencut_wasm_bg.js');const {instance}=await WebAssembly.instantiate(await(await fetch('/opencut_wasm_bg.wasm')).arrayBuffer(),{'./opencut_wasm_bg.js':glue});glue.__wbg_set_wasm(instance.exports);instance.exports.__wbindgen_start();`;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				if (path === "/opencut_wasm_bg.js")
					return new Response(
						Bun.file(new URL("opencut_wasm_bg.js", wasmRoot)),
						{ headers: { "Content-Type": "text/javascript" } },
					);
				if (path === "/opencut_wasm_bg.wasm")
					return new Response(
						Bun.file(new URL("opencut_wasm_bg.wasm", wasmRoot)),
						{ headers: { "Content-Type": "application/wasm" } },
					);
				if (path === "/fixture.js")
					return new Response(script, {
						headers: { "Content-Type": "text/javascript" },
					});
				return new Response(
					"<!doctype html><title>Code audio export test</title>",
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
		let lease: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
		try {
			lease = await acquireBrowser(
				["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
				{
					enableBrowserPool: false,
					forceScreenshot: true,
				},
			);
			const page = await lease.browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}`);
			await page.evaluate(`(async () => { ${boot} })()`);
			const result = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).exportPcmParity(),
			);
			expect(result.frames).toBe(6 * 44100);
			expect(result.rms).toBeLessThan(0.001);
			expect(result.seamRms).toBeLessThan(0.001);
			expect(result.peak).toBeGreaterThan(0.05);
			expect(result.silenceHead).toBe(0);
			expect(result.silenceTail).toBe(0);
			expect(result.synthesized.sort()).toEqual([31, 71]);
			expect(
				result.created.filter((name: string) => name.startsWith("source-")),
			).toHaveLength(2);
			expect(
				result.created.every((name: string) => name.endsWith(".pcm")),
			).toBe(true);
			expect(
				result.created
					.filter((name: string) => name !== "mix.pcm")
					.every((name: string) => result.removed.includes(name)),
			).toBe(true);
			expect(result.unchanged).toBe(true);
			const failure = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).failedCodeExport(),
			);
			expect(failure).toContain("Fixture synthesis failed");
			console.log("Earshot export PCM parity", JSON.stringify(result));
			const mp4 = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).exportMp4RoundTrip(),
			);
			console.log("Earshot MP4 decode", JSON.stringify(mp4));
			expect(mp4.bytes).toBeGreaterThan(1000);
			expect(mp4.box).toBe("ftyp");
			expect(mp4.videoDuration).toBeCloseTo(3, 4);
			// Native AAC encoders pad complete frames; constrain that overhead and
			// require the same duration as the existing single-buffer encoder path.
			expect(Math.abs(mp4.audioDuration - 3)).toBeLessThan(0.12);
			const control = await page.evaluate(async () =>
				(await import(`${location.origin}/fixture.js`)).exportMp4RoundTrip(
					true,
				),
			);
			expect(mp4.audioDuration).toBeCloseTo(control.audioDuration, 4);
			expect(mp4.audioCodec).toBe(control.audioCodec);
			expect(mp4.videoPackets).toBe(75);
			expect(mp4.audioTracks).toBe(1);
			expect([mp4.width, mp4.height]).toEqual([160, 90]);
			expect(mp4.decodedChannels).toBe(2);
			expect(mp4.decodedPeak).toBeGreaterThan(0.05);
			expect(mp4.decodedRms).toBeGreaterThan(0.02);
		} finally {
			if (lease)
				await releaseBrowser(lease.browser, { enableBrowserPool: false });
			server.stop(true);
		}
	},
	120000,
);
