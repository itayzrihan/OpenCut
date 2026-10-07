// @opencut-test-wasm: real
/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Isolated real-browser export fixture and canonical JSON. */
import { expect, test } from "bun:test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { acquireBrowser } from "@hyperframes/engine";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	CanonicalClassicSession,
	type CanonicalClassicSnapshot,
} from "@/core/canonical-classic-session";
import { HyperframesCaptureSession } from "../capture-session";
import { HyperframesPreviewHost } from "../preview-host";
import { renderHyperframesAudio } from "../audio-render";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_EXPORT_TEST !== "1")(
	"a pinned reference survives canonical import/reopen and real video export above footage and without footage",
	async () => {
		const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
		const output = path.join(
			root,
			".local/hyperframes-mixed-export",
			crypto.randomUUID(),
		);
		await mkdir(output, { recursive: true });
		const run = async (args: string[]) => {
			const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
			const [bytes, error, code] = await Promise.all([
				new Response(process.stdout).arrayBuffer(),
				new Response(process.stderr).text(),
				process.exited,
			]);
			if (code) throw new Error(error);
			return new Uint8Array(bytes);
		};
		const ffmpeg = process.env.OPENCUT_FFMPEG ?? "ffmpeg";
		await run([
			ffmpeg,
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=3",
			"-y",
			path.join(output, "tone.wav"),
		]);
		await run([
			ffmpeg,
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=0x1451c5:s=640x360:r=10:d=1",
			"-c:v",
			"libvpx-vp9",
			"-y",
			path.join(output, "clip.webm"),
		]);
		const bundle = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL("./examples-export-fixture.ts", import.meta.url)),
			],
			target: "browser",
			format: "esm",
			plugins: [
				{
					name: "real-browser-wasm",
					setup(build) {
						build.onResolve({ filter: /^opencut-wasm$/ }, () => ({
							path: "/opencut_wasm_bg.js",
							external: true,
						}));
					},
				},
			],
		});
		if (!bundle.success) throw new Error(bundle.logs.join("\n"));
		const runtime = await createCanonicalTestRuntime();
		const session = new CanonicalClassicSession({
			runtime: await createCanonicalTestRuntime(),
			projectId: "classic-project",
		});
		const host = new HyperframesPreviewHost();
		const base =
			"resources/hyperframes/upstream/4c4b8574406cc566d28778a13f22c072d727a871/registry/blocks/lt-clean-bar";
		const source = {
			entryFile: "lt-clean-bar.html",
			resourceAssetIds: { "tone.wav": "reference-tone" },
			files: {
				"lt-clean-bar.html": (
					await readFile(path.join(root, base, "lt-clean-bar.html"), "utf8")
				).replaceAll(
					"https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
					"/gsap.js",
				),
				"gsap.js": await readFile(
					path.join(
						root,
						"resources/hyperframes/vendor/gsap/3.14.2/dist/gsap.min.js",
					),
					"utf8",
				),
			},
		};
		// An actual remix adds timed source audio to the preserved reference.
		source.files["lt-clean-bar.html"] = source.files[
			"lt-clean-bar.html"
		].replace(
			"</body>",
			'<audio id="reference-audio" src="tone.wav" data-start="0.4" data-duration="0.9" data-media-start="0.1" data-playback-rate="2" data-volume="0.5"></audio></body>',
		);
		const resources = new Map([
			[
				"tone.wav",
				{
					path: path.join(output, "tone.wav"),
					mimeType: "audio/wav",
					size: (await readFile(path.join(output, "tone.wav"))).length,
				},
			],
		]);
		const capture = await HyperframesCaptureSession.open({
			source,
			runtime,
			host,
			resources,
			bundledOnly: true,
		});
		const audioProbe = await HyperframesCaptureSession.open({
			source,
			runtime,
			host,
			resources,
			bundledOnly: true,
		});
		const plan = await audioProbe.consumeAudioPlan({ source });
		expect(plan.elements.length).toBe(1);
		expect(plan.elements[0].start).toBe(0.4);
		expect(plan.elements[0].playbackRate).toBe(2);
		const audio = await renderHyperframesAudio({
			source,
			plan,
			resources,
			runtime,
		});
		if (!audio) throw new Error("The remixed source audio was lost");
		const assets = new Map<
			string,
			{ type: string; bytes: Uint8Array | string }
		>([
			[
				"/hyperframes-audio.m4a",
				{ type: "audio/mp4", bytes: runtime.readArtifact(audio.uri) },
			],
			[
				"/",
				{
					type: "text/html",
					bytes:
						'<!doctype html><script type="importmap">{"imports":{"opencut-wasm":"/opencut_wasm_bg.js"}}</script><body>OpenCut export acceptance</body>',
				},
			],
			[
				"/fixture.js",
				{ type: "text/javascript", bytes: await bundle.outputs[0].text() },
			],
			[
				"/opencut_wasm_bg.js",
				{
					type: "text/javascript",
					bytes: await readFile(
						path.join(root, "classic/rust/wasm/pkg/opencut_wasm_bg.js"),
					),
				},
			],
			[
				"/opencut_wasm_bg.wasm",
				{
					type: "application/wasm",
					bytes: await readFile(
						path.join(root, "classic/rust/wasm/pkg/opencut_wasm_bg.wasm"),
					),
				},
			],
			[
				"/clip.webm",
				{
					type: "video/webm",
					bytes: await readFile(path.join(output, "clip.webm")),
				},
			],
		]);
		const captureRequests: number[] = [];
		const server = createServer((request, response) => {
			void (async () => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				if (url.pathname === "/capture") {
					captureRequests.push(Number(url.searchParams.get("time")));
					const artifact = await capture.capture({
						timeSeconds: Number(url.searchParams.get("time")),
					});
					response.writeHead(200, { "Content-Type": "image/png" });
					response.end(runtime.readArtifact(artifact.uri));
					return;
				}
				const asset = assets.get(url.pathname);
				if (!asset) {
					response.writeHead(404);
					response.end();
					return;
				}
				response.writeHead(200, { "Content-Type": asset.type });
				response.end(asset.bytes);
			})().catch((error: unknown) => {
				response.writeHead(500);
				response.end(String(error));
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No test server address");
		const origin = `http://127.0.0.1:${address.port}`;
		const lease = await acquireBrowser(
			["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
			{ enableBrowserPool: false, forceScreenshot: true },
		);
		try {
			const classic = JSON.parse(
				await readFile(
					path.join(
						root,
						"crates/editor-api/tests/fixtures/classic-project.json",
					),
					"utf8",
				),
			) as CanonicalClassicSnapshot;
			const scene = classic.document.scenes[0];
			delete scene.parallax;
			scene.tracks.overlay = [];
			scene.tracks.order = [scene.tracks.main.id];
			scene.tracks.main.elements = [
				{
					id: "native-video",
					type: "video",
					name: "Native blue clip",
					mediaId: "video-asset",
					startTime: 0,
					duration: 120000,
					trimStart: 0,
					trimEnd: 0,
					params: {},
				},
			] as typeof scene.tracks.main.elements;
			classic.mediaAssets[0] = {
				id: "video-asset",
				name: "Native clip",
				type: "video",
				duration: 1,
				width: 640,
				height: 360,
			};
			session.attach({ classic });
			session.importHyperframes({
				name: "Clean bar reference",
				source,
				startSeconds: 0,
				runtimeManifest: capture.runtimeManifest,
				classicResourceAssets: [
					{
						id: "reference-tone",
						name: "Reference tone",
						type: "audio",
						duration: 3,
						size: resources.get("tone.wav")!.size,
					},
				],
			});
			const reopened = new CanonicalClassicSession({
				runtime: await createCanonicalTestRuntime(),
				projectId: "classic-project",
			});
			let snapshot: CanonicalClassicSnapshot;
			try {
				reopened.restore(session.archive());
				snapshot = reopened.read();
			} finally {
				reopened.dispose();
			}
			const page = await lease.browser.newPage();
			await page.goto(origin);
			const bytes = await page.evaluate(async (snapshot) => {
				const glue = await import(`${location.origin}/opencut_wasm_bg.js`);
				const { instance } = await WebAssembly.instantiate(
					await (await fetch("/opencut_wasm_bg.wasm")).arrayBuffer(),
					{ "./opencut_wasm_bg.js": glue },
				);
				glue.__wbg_set_wasm(instance.exports);
				const start = instance.exports.__wbindgen_start;
				if (typeof start === "function") start();
				return (await import(`${location.origin}/fixture.js`)).exportReference(
					snapshot,
				);
			}, snapshot);
			const exported = path.join(output, "mixed-export.webm");
			await writeFile(exported, new Uint8Array(bytes));
			await writeFile(
				path.join(output, "debug.json"),
				JSON.stringify({ snapshot, captureRequests }, null, 2),
			);
			const raw = await capture.capture({ timeSeconds: 0.8 });
			await writeFile(
				path.join(output, "reference-0.8.png"),
				runtime.readArtifact(raw.uri),
			);
			expect(captureRequests.length).toBeGreaterThan(0);
			for (const time of [0.8, 1.6]) {
				const png = await run([
					ffmpeg,
					"-v",
					"error",
					"-ss",
					String(time),
					"-i",
					exported,
					"-frames:v",
					"1",
					"-vf",
					"scale=640:360",
					"-f",
					"image2pipe",
					"-vcodec",
					"png",
					"pipe:1",
				]);
				await writeFile(path.join(output, `export-${time}.png`), png);
				const decoded = await sharp(png)
					.removeAlpha()
					.raw()
					.toBuffer({ resolveWithObject: true });
				expect(decoded.info.width).toBe(640);
				expect(decoded.info.height).toBe(360);
				const background = (20 * 640 + 20) * 3;
				if (time < 1) {
					expect(decoded.data[background + 2]).toBeGreaterThan(150);
					expect(decoded.data[background]).toBeLessThan(40);
				} else
					expect(
						Math.max(...decoded.data.subarray(background, background + 3)),
					).toBeLessThan(10);
				const whites = decoded.data.filter(
					(value, index) =>
						index % 3 === 0 &&
						value > 230 &&
						decoded.data[index + 1] > 230 &&
						decoded.data[index + 2] > 230,
				);
				expect(whites.length).toBeGreaterThan(1000);
			}
			expect(capture.externalRequests).toEqual([]);
			const pcmBytes = await run([
				ffmpeg,
				"-v",
				"error",
				"-i",
				exported,
				"-vn",
				"-ac",
				"1",
				"-ar",
				"8000",
				"-f",
				"f32le",
				"pipe:1",
			]);
			const pcm = new Float32Array(pcmBytes.buffer);
			const rms = ({ start, end }: { start: number; end: number }) => {
				const samples = pcm.slice(start * 8000, end * 8000);
				return Math.sqrt(
					samples.reduce((sum, value) => sum + value * value, 0) /
						samples.length,
				);
			};
			expect(rms({ start: 0.05, end: 0.25 })).toBeLessThan(0.002);
			expect(rms({ start: 0.6, end: 1 })).toBeGreaterThan(0.01);
			expect(rms({ start: 1.5, end: 1.8 })).toBeLessThan(0.002);
			await writeFile(
				path.join(output, "report.json"),
				JSON.stringify(
					{
						reference: "lt-clean-bar",
						canonicalImportAndReopen: true,
						actualSceneExporter: true,
						actualWasmCompositor: true,
						nativeVideoUnderlay: true,
						standaloneInterval: true,
						timedHyperframesAudioInExport: {
							start: 0.4,
							end: 1.3,
							playbackRate: 2,
							rmsBefore: rms({ start: 0.05, end: 0.25 }),
							rmsDuring: rms({ start: 0.6, end: 1 }),
							rmsAfter: rms({ start: 1.5, end: 1.8 }),
						},
						file: "mixed-export.webm",
						decodedFrames: [0.8, 1.6],
					},
					null,
					2,
				),
			);
			console.log(`Mixed export evidence: ${output}`);
			await page.close();
		} finally {
			await lease.release();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await capture.close();
			await host.close();
			session.dispose();
			runtime.free();
		}
	},
	300000,
);
