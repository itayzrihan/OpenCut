/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Read the pinned runtime and test observations in isolated browser fixtures. */
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import {
	createCaptureSession,
	closeCaptureSession,
	type CaptureSession,
} from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesPreviewHost } from "../preview-host";
import { HyperframesCaptureSession } from "../capture-session";
import { prepareHyperframesPreview } from "../preview-document";
import type { HyperframesSource } from "../types";

const browserTest = test.skipIf(
	process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1",
);

browserTest(
	"live media failures and overlapping seeks report errors without acknowledging incomplete frames",
	async () => {
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesPreviewHost();
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-media-errors-"));
		const brokenVideo = join(directory, "broken.mp4");
		let engine: CaptureSession | undefined;
		try {
			await writeFile(brokenVideo, "invalid video");
			for (const failure of ["drawing", "overlap", "decode"] as const) {
				const source: HyperframesSource = {
					entryFile: "index.html",
					resourceAssetIds: { "broken.mp4": "broken" },
					files: {
						"index.html": `<!doctype html><html><body>
<div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4">
${failure === "decode" ? '<video src="broken.mp4" data-start="0" data-duration="4"></video>' : "<canvas></canvas>"}
</div><script>window.addEventListener('hf-seek',event=>{
 if(event.detail.time<0.2)return;
 event.detail.waitUntil(${failure === "drawing" ? "Promise.reject(new Error('fixture drawing failed'))" : "new Promise(resolve=>setTimeout(resolve,100))"});
});</script></body></html>`,
					},
				};
				const compiled = prepareHyperframesPreview({
					source,
					runtime,
					liveDurationSeconds: 4,
				});
				const live = await host.add({
					source,
					html: compiled.html,
					live: true,
					resources: new Map([
						[
							"broken.mp4",
							{ path: brokenVideo, mimeType: "video/mp4", size: 13 },
						],
					]),
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
				await page.evaluateOnNewDocument(() => {
					const state = window as unknown as {
						events: Array<{ type: string }>;
					};
					state.events = [];
					window.addEventListener("message", (event) => {
						if (
							event.source === window &&
							event.data?.source === "opencut-hf-live"
						)
							state.events.push(event.data);
					});
				});
				await page.goto(live.url, { waitUntil: "load" });
				await page.waitForFunction(
					() =>
						(
							window as unknown as { events: Array<{ type: string }> }
						).events.some((e) => e.type === "ready" || e.type === "error"),
					{ timeout: 20_000 },
				);
				if (failure !== "decode") {
					expect(
						await page.evaluate(() =>
							(
								window as unknown as { events: Array<{ type: string }> }
							).events.some((e) => e.type === "ready"),
						),
					).toBe(true);
					await page.evaluate((overlap) => {
						window.postMessage(
							{
								source: "opencut-hf-live",
								type: "seek",
								sequence: 1,
								timeSeconds: 1,
							},
							"*",
						);
						if (overlap)
							window.postMessage(
								{
									source: "opencut-hf-live",
									type: "seek",
									sequence: 2,
									timeSeconds: 2,
								},
								"*",
							);
					}, failure === "overlap");
				}
				await page.waitForFunction(
					() =>
						(
							window as unknown as { events: Array<{ type: string }> }
						).events.some((e) => e.type === "error"),
					{ timeout: 5_000 },
				);
				// Let the first asynchronous draw finish to detect a late false acknowledgement.
				await page.evaluate(
					() => new Promise((resolve) => setTimeout(resolve, 250)),
				);
				const events = await page.evaluate(
					() =>
						(
							window as unknown as {
								events: Array<{ type: string; message?: string }>;
							}
						).events,
				);
				expect(events.filter((e) => e.type === "frame")).toEqual([]);
				expect(events.filter((e) => e.type === "error")).toHaveLength(1);
				if (failure === "overlap")
					expect(events.find((e) => e.type === "error")!.message).toContain(
						"overlapping",
					);
				if (failure === "decode")
					expect(events.some((e) => e.type === "ready")).toBe(false);
				await closeCaptureSession(engine);
				engine = undefined;
			}
		} finally {
			if (engine) await closeCaptureSession(engine);
			await host.close();
			runtime.free();
			await unlink(brokenVideo).catch(() => {});
			await rmdir(directory);
		}
	},
	60_000,
);
const run = promisify(execFile);

browserTest(
	"cold native video captures display decoded frames after fast seeks and visibility changes",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-cold-video-"));
		const videoPath = join(directory, "video.mp4");
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesPreviewHost();
		try {
			await run(
				process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
				[
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=96x64:rate=30:duration=3",
					"-an",
					"-c:v",
					"libx264",
					"-crf",
					"0",
					"-g",
					"1",
					"-preset",
					"ultrafast",
					"-y",
					videoPath,
				],
				{ windowsHide: true, timeout: 30_000 },
			);
			const references = new Map<number, Buffer>();
			for (const frame of [12, 60]) {
				const decoded = await run(
					process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
					[
						"-v",
						"error",
						"-i",
						videoPath,
						"-vf",
						`select=eq(n\\,${frame})`,
						"-frames:v",
						"1",
						"-f",
						"image2pipe",
						"-c:v",
						"png",
						"pipe:1",
					],
					{
						windowsHide: true,
						timeout: 10_000,
						encoding: "buffer",
						maxBuffer: 1024 * 1024,
					},
				);
				references.set(
					frame,
					await sharp(decoded.stdout).removeAlpha().raw().toBuffer(),
				);
			}
			const source: HyperframesSource = {
				entryFile: "index.html",
				resourceAssetIds: { "video.mp4": "video" },
				files: {
					"index.html": `<!doctype html><html><body style="margin:0">
<div data-composition-id="main" data-no-timeline data-width="384" data-height="192" data-duration="4">
${Array.from({ length: 12 }, (_, i) => `<video id="v${i}" muted playsinline src="video.mp4" data-start="1" data-duration="3" style="position:absolute;left:${(i % 4) * 96}px;top:${Math.floor(i / 4) * 64}px;width:96px;height:64px"></video>`).join("")}
</div></body></html>`,
				},
			};
			const resources = new Map([
				[
					"video.mp4",
					{
						path: videoPath,
						size: (await readFile(videoPath)).length,
						mimeType: "video/mp4",
					},
				],
			]);
			// A cold fast decode exposed this intermittently. Repeat with fresh
			// browser sessions, then cover forward/reverse and hide/reveal too.
			for (let repeat = 0; repeat < 4; repeat++) {
				const capture = await HyperframesCaptureSession.open({
					source,
					resources,
					runtime,
					host,
				});
				try {
					for (const timeSeconds of [1.4, 3, 1.4, 0, 1.4]) {
						const artifact = await capture.capture({ timeSeconds });
						const pixels = runtime.readArtifact(artifact.uri);
						if (timeSeconds === 0) {
							const alpha = await sharp(pixels)
								.ensureAlpha()
								.extractChannel(3)
								.raw()
								.toBuffer();
							expect(alpha.every((value) => value === 0)).toBe(true);
							continue;
						}
						const expected = references.get(timeSeconds === 3 ? 60 : 12)!;
						for (let i = 0; i < 12; i++) {
							const actual = await sharp(pixels)
								.extract({
									left: (i % 4) * 96,
									top: Math.floor(i / 4) * 64,
									width: 96,
									height: 64,
								})
								.removeAlpha()
								.raw()
								.toBuffer();
							let error = 0;
							for (let n = 0; n < actual.length; n++)
								error += Math.abs(actual[n] - expected[n]);
							// Browser and FFmpeg YUV conversion differ slightly; a stale
							// frame zero has a mean RGB error above 23 in this fixture.
							expect(error / actual.length).toBeLessThan(2);
						}
					}
				} finally {
					await capture.close();
				}
			}
		} finally {
			await host.close();
			runtime.free();
			await unlink(videoPath).catch(() => {});
			await rmdir(directory);
		}
	},
	60_000,
);

browserTest(
	"live video and asynchronous canvas match captured pixels across forward, reverse and repeated seeks",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-live-media-"));
		const videoPath = join(directory, "video.mp4");
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesPreviewHost();
		let engine: CaptureSession | undefined;
		let capture: HyperframesCaptureSession | undefined;
		try {
			await run(
				process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
				[
					"-v",
					"error",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=96x64:rate=30:duration=4",
					"-an",
					"-c:v",
					"libx264",
					"-crf",
					"10",
					"-pix_fmt",
					"yuv420p",
					"-g",
					"15",
					"-y",
					videoPath,
				],
				{ windowsHide: true, timeout: 30_000 },
			);
			const videoBytes = await readFile(videoPath);
			const resources = new Map([
				[
					"video.mp4",
					{ path: videoPath, mimeType: "video/mp4", size: videoBytes.length },
				],
			]);
			const source: HyperframesSource = {
				entryFile: "index.html",
				resourceAssetIds: { "video.mp4": "video" },
				files: {
					"index.html": `<!doctype html><html><head><style>
html,body{margin:0;width:320px;height:180px;background:transparent}
video{position:absolute;left:0;top:0;width:96px;height:64px}canvas{position:absolute;left:120px;top:20px}
</style></head><body><div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4">
<video id="media" class="clip" src="video.mp4" playsinline data-start="0.5" data-duration="3.5" data-media-start="0.25" data-playback-rate="1.5"></video>
<canvas id="paint" width="120" height="100"></canvas></div><script>
const ctx=document.getElementById('paint').getContext('2d');
window.addEventListener('hf-seek',event=>{
 const t=event.detail.time;
 event.detail.waitUntil(new Promise(resolve=>setTimeout(()=>{
  ctx.clearRect(0,0,120,100);ctx.fillStyle='rgba(0,255,0,.5)';
  ctx.fillRect(Math.floor(t*15),10,30,30);
  if(t>=0.5&&t<4)ctx.drawImage(document.getElementById('media'),0,36,96,64);
  window.lastPaint=t;resolve();
 },40)));
});</script></body></html>`,
				},
			};
			capture = await HyperframesCaptureSession.open({
				source,
				resources,
				runtime,
				host,
			});
			const compiled = prepareHyperframesPreview({
				source,
				runtime,
				liveDurationSeconds: 4,
			});
			const live = await host.add({
				source,
				resources,
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
			await page.evaluateOnNewDocument(() => {
				const state = window as unknown as {
					events: Array<{ type: string; sequence?: number; message?: string }>;
				};
				state.events = [];
				window.addEventListener("message", (event) => {
					if (
						event.source === window &&
						event.data?.source === "opencut-hf-live"
					)
						state.events.push(event.data);
				});
			});
			await page.goto(live.url, { waitUntil: "load" });
			await page.waitForFunction(
				() =>
					(
						window as unknown as { events: Array<{ type: string }> }
					).events.some((e) => e.type === "ready" || e.type === "error"),
				{ timeout: 20_000 },
			);
			const frames: Buffer[] = [];
			const times = [0, 0.5, 1, 2, 3.9, 0.5, 2, 0];
			for (const [index, timeSeconds] of times.entries()) {
				await page.evaluate(
					({ sequence, timeSeconds }) =>
						window.postMessage(
							{
								source: "opencut-hf-live",
								type: "seek",
								sequence,
								timeSeconds,
							},
							"*",
						),
					{ sequence: index + 1, timeSeconds },
				);
				await page.waitForFunction(
					(sequence) =>
						(
							window as unknown as {
								events: Array<{ type: string; sequence?: number }>;
							}
						).events.some(
							(e) =>
								e.type === "error" ||
								(e.type === "frame" && e.sequence === sequence),
						),
					{ timeout: 5_000 },
					index + 1,
				);
				const errors = await page.evaluate(() =>
					(
						window as unknown as {
							events: Array<{ type: string; message?: string }>;
						}
					).events.filter((e) => e.type === "error"),
				);
				expect(errors).toEqual([]);
				const authored = page
					.frames()
					.find((frame) => new URL(frame.url()).pathname === "/index.html")!;
				const observed = await authored.evaluate(() => {
					const video = document.querySelector("video")!;
					const state = window as unknown as {
						lastPaint: number;
						__player: { getTime: () => number };
					};
					return {
						muted: video.muted,
						paused: video.paused,
						seeking: video.seeking,
						sourceTime: video.currentTime,
						paint: state.lastPaint,
						time: state.__player.getTime(),
					};
				});
				expect(observed.muted).toBe(true);
				expect(observed.paused).toBe(true);
				expect(observed.seeking).toBe(false);
				expect(observed.paint).toBe(observed.time);
				if (timeSeconds >= 0.5)
					expect(observed.sourceTime).toBeCloseTo(
						Math.min(4, (timeSeconds - 0.5) * 1.5 + 0.25),
						5,
					);
				const liveBytes = Buffer.from(
					await page.screenshot({ type: "png", omitBackground: true }),
				);
				const artifact = await capture.capture({ timeSeconds });
				const actual = await sharp(liveBytes).ensureAlpha().raw().toBuffer();
				const expected = await sharp(runtime.readArtifact(artifact.uri))
					.ensureAlpha()
					.raw()
					.toBuffer();
				let difference = 0;
				for (let n = 0; n < actual.length; n++)
					difference += Math.abs(actual[n] - expected[n]);
				if (difference / actual.length >= 0.1) {
					console.log({
						timeSeconds,
						observed,
						meanError: difference / actual.length,
					});
					if (process.env.OPENCUT_HYPERFRAMES_TEST_ARTIFACTS) {
						await writeFile(
							join(process.env.OPENCUT_HYPERFRAMES_TEST_ARTIFACTS, "live.png"),
							liveBytes,
						);
						await writeFile(
							join(
								process.env.OPENCUT_HYPERFRAMES_TEST_ARTIFACTS,
								"capture.png",
							),
							runtime.readArtifact(artifact.uri),
						);
					}
				}
				expect(difference / actual.length).toBeLessThan(0.1);
				if (timeSeconds >= 0.5) {
					// Independent source-frame reference: two render paths agreeing is
					// insufficient if both accidentally keep the first decoded frame.
					const frame = Math.min(
						119,
						Math.floor(((timeSeconds - 0.5) * 1.5 + 0.25) * 30 + 1e-9),
					);
					const decoded = await run(
						process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
						[
							"-v",
							"error",
							"-i",
							videoPath,
							"-vf",
							`select=eq(n\\,${frame})`,
							"-frames:v",
							"1",
							"-f",
							"image2pipe",
							"-c:v",
							"png",
							"pipe:1",
						],
						{
							windowsHide: true,
							timeout: 10_000,
							encoding: "buffer",
							maxBuffer: 1024 * 1024,
						},
					);
					const reference = await sharp(decoded.stdout)
						.removeAlpha()
						.raw()
						.toBuffer();
					const visible = await sharp(liveBytes)
						.extract({ left: 0, top: 0, width: 96, height: 64 })
						.removeAlpha()
						.raw()
						.toBuffer();
					let error = 0;
					for (let n = 0; n < visible.length; n++)
						error += Math.abs(visible[n] - reference[n]);
					expect(error / visible.length).toBeLessThan(2);
					const canvasVideo = await sharp(liveBytes)
						.extract({ left: 120, top: 56, width: 96, height: 64 })
						.removeAlpha()
						.raw()
						.toBuffer();
					let canvasError = 0;
					for (let n = 0; n < canvasVideo.length; n++)
						canvasError += Math.abs(canvasVideo[n] - reference[n]);
					expect(canvasError / canvasVideo.length).toBeLessThan(2);
				}
				frames.push(actual);
			}
			expect(frames[0].equals(frames[7])).toBe(true);
			expect(frames[1].equals(frames[5])).toBe(true);
			expect(frames[3].equals(frames[6])).toBe(true);
			expect(frames[1].equals(frames[3])).toBe(false);
		} finally {
			if (engine) await closeCaptureSession(engine);
			if (capture) await capture.close();
			await host.close();
			runtime.free();
			await unlink(videoPath).catch(() => {});
			await rmdir(directory);
		}
	},
	60_000,
);
