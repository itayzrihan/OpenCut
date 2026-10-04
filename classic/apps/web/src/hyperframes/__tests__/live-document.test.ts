/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Renderer fixture events cross an opaque sandbox boundary. */
import { expect, test } from "bun:test";
import { mkdtemp, rmdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	createCaptureSession,
	closeCaptureSession,
	type CaptureSession,
} from "@hyperframes/engine";
import sharp from "sharp";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesPreviewHost } from "../preview-host";
import { prepareHyperframesPreview } from "../preview-document";
import type { HyperframesSource } from "../types";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"the silent live document seeks through an opaque shell and cannot navigate outside its package",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesPreviewHost();
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-live-test-"));
		const audioPath = join(directory, "voice.wav");
		const wave = Buffer.alloc(16044);
		wave.write("RIFF");
		wave.writeUInt32LE(16036, 4);
		wave.write("WAVEfmt ", 8);
		wave.writeUInt32LE(16, 16);
		wave.writeUInt16LE(1, 20);
		wave.writeUInt16LE(1, 22);
		wave.writeUInt32LE(8000, 24);
		wave.writeUInt32LE(16000, 28);
		wave.writeUInt16LE(2, 32);
		wave.writeUInt16LE(16, 34);
		wave.write("data", 36);
		wave.writeUInt32LE(16000, 40);
		await writeFile(audioPath, wave);
		let engine: CaptureSession | undefined;
		const source: HyperframesSource = {
			entryFile: "index.html",
			resourceAssetIds: { "voice.wav": "voice" },
			files: {
				"index.html": `<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;background:transparent}.square{position:absolute;left:0;top:20px;width:40px;height:40px;background:rgba(255,0,0,.5);animation:move 4s linear both}@keyframes move{from{transform:translateX(0)}to{transform:translateX(160px)}}</style></head><body><div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4"><div class="square"></div></div><script>window.addEventListener('message',e=>{if(e.data?.source==='opencut-hf-live'&&e.data.timeSeconds===3)location.href='https://example.com/';});</script></body></html>`,
			},
		};
		source.files["index.html"] = source.files["index.html"].replace(
			"</body>",
			'<audio id="voice" src="voice.wav" data-start="0" data-duration="4" autoplay loop></audio><script>window.probeAudio = new AudioContext(); const tone = probeAudio.createOscillator(); tone.connect(probeAudio.destination); tone.start();</script></body>',
		);
		try {
			const compiled = prepareHyperframesPreview({
				source,
				runtime,
				liveDurationSeconds: 4,
			});
			const live = await host.add({
				source,
				resources: new Map([
					[
						"voice.wav",
						{ path: audioPath, mimeType: "audio/wav", size: wave.byteLength },
					],
				]),
				html: compiled.html,
				live: true,
			});
			engine = await createCaptureSession(
				new URL(live.url).origin,
				directory,
				{
					entryUrl: live.url,
					width: 320,
					height: 180,
					fps: { num: 30, den: 1 },
					format: "png",
				},
				null,
				{
					forceScreenshot: true,
					useDrawElement: false,
					browserGpuMode: "software",
					enableBrowserPool: false,
				},
			);
			const page = engine.page;
			const requests: string[] = [];
			page.on("request", (request) => requests.push(request.url()));
			await page.evaluateOnNewDocument(() => {
				const page = window as unknown as {
					events: unknown[];
					outputConnections: number;
				};
				page.events = [];
				page.outputConnections = 0;
				const connect = AudioNode.prototype.connect;
				Object.defineProperty(AudioNode.prototype, "connect", {
					configurable: true,
					writable: true,
					value: function (this: AudioNode, ...args: unknown[]) {
						if (args[0] instanceof AudioDestinationNode)
							page.outputConnections++;
						return Reflect.apply(connect, this, args);
					},
				});
				window.addEventListener("message", (event) => {
					if (
						event.source === window &&
						event.data?.source === "opencut-hf-live"
					)
						page.events.push(event.data);
				});
			});
			await page.goto(live.url, { waitUntil: "load" });
			await page.waitForFunction(
				() =>
					(
						window as unknown as { events: Array<{ type: string }> }
					).events.some((event) => event.type === "ready"),
				{ timeout: 15_000 },
			);
			expect(
				await page.evaluate(() =>
					(
						window as unknown as {
							events: Array<{ type: string; stage?: string }>;
						}
					).events
						.filter((event) => event.type === "loading")
						.map((event) => event.stage),
				),
			).toEqual(["document", "runtime", "fonts", "images"]);
			const captures: Buffer[] = [];
			for (const [index, timeSeconds] of [0.5, 2, 0.519, 0.5].entries()) {
				await page.evaluate(
					({ timeSeconds, sequence }) =>
						window.postMessage(
							{
								source: "opencut-hf-live",
								type: "seek",
								sequence,
								timeSeconds,
							},
							"*",
						),
					{ timeSeconds, sequence: index + 1 },
				);
				await page.waitForFunction(
					(sequence) =>
						(
							window as unknown as {
								events: Array<{ type: string; sequence: number }>;
							}
						).events.some(
							(event) => event.type === "frame" && event.sequence === sequence,
						),
					{},
					index + 1,
				);
				captures.push(
					Buffer.from(
						await page.screenshot({ type: "png", omitBackground: true }),
					),
				);
			}
			expect(captures[0]).toEqual(captures[2]);
			expect(captures[0]).toEqual(captures[3]);
			const authored = page
				.frames()
				.find((frame) => new URL(frame.url()).pathname === "/index.html");
			expect(authored).toBeDefined();
			expect(
				await authored!.evaluate(() => ({
					muted: [
						...document.querySelectorAll<HTMLMediaElement>("audio,video"),
					].every((media) => media.muted),
					outputConnections: (
						window as unknown as { outputConnections: number }
					).outputConnections,
				})),
			).toEqual({ muted: true, outputConnections: 0 });
			const pixels = await sharp(captures[0]).ensureAlpha().raw().toBuffer();
			expect(pixels[(25 * 320 + 25) * 4 + 3]).toBe(128);
			expect(pixels[(170 * 320 + 310) * 4 + 3]).toBe(0);
			const later = await sharp(captures[1]).ensureAlpha().raw().toBuffer();
			expect(later[(25 * 320 + 85) * 4 + 3]).toBe(128);
			expect(later[(25 * 320 + 25) * 4 + 3]).toBe(0);
			await page.evaluate(() =>
				window.postMessage(
					{
						source: "opencut-hf-live",
						type: "seek",
						sequence: 5,
						timeSeconds: 3,
					},
					"*",
				),
			);
			await page.waitForFunction(() =>
				(window as unknown as { events: Array<{ type: string }> }).events.some(
					(event) => event.type === "error",
				),
			);
			expect(
				requests.some((url) => url.startsWith("https://example.com")),
			).toBe(false);
			expect(
				page
					.frames()
					.every((frame) => !frame.url().startsWith("https://example.com")),
			).toBe(true);
		} finally {
			if (engine) await closeCaptureSession(engine);
			await host.close();
			runtime.free();
			await unlink(audioPath);
			await rmdir(directory);
		}
	},
	60_000,
);
