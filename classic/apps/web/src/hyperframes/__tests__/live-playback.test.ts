/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Inspect the pinned runtime inside an isolated browser fixture. */
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
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
import { prepareHyperframesPreview } from "../preview-document";
import type { HyperframesSource } from "../types";

type ParentFixture = {
	events: Array<{ type: string; sequence?: number; message?: string }>;
	request: (input: {
		timeSeconds: number;
		playing?: boolean;
		endTimeSeconds?: number;
	}) => Promise<void>;
};
type AuthoredFixture = {
	__player: {
		getTime: () => number;
		isPlaying: () => boolean;
		seek: (time: number) => void | Promise<void>;
	};
	__opencutLayerEdits?: { beforeSeek: () => void; afterSeek: () => void };
	observed: {
		frames: number;
		seeks: number;
		before: number;
		after: number;
		starting: boolean;
		playerSeeks: number;
	};
};
const run = promisify(execFile);

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"continuous native playback follows parent time, stops on pause or lost updates, and preserves exact seeks",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-playback-"));
		const videoPath = join(directory, "video.mp4");
		const runtime = await createCanonicalTestRuntime();
		const host = new HyperframesPreviewHost();
		let engine: CaptureSession | undefined;
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
			const source: HyperframesSource = {
				entryFile: "index.html",
				resourceAssetIds: { "video.mp4": "video" },
				files: {
					"index.html": `<!doctype html><html><body style="margin:0">
<div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4">
<video id="media" class="clip" muted playsinline src="video.mp4" data-start="0.5" data-duration="3" data-media-start="0.25" data-playback-rate="1.5" style="width:96px;height:64px"></video>
</div></body></html>`,
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
						"video.mp4",
						{
							path: videoPath,
							mimeType: "video/mp4",
							size: (await readFile(videoPath)).length,
						},
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
				const state = window as unknown as ParentFixture;
				state.events = [];
				let sequence = 0;
				window.addEventListener("message", (event) => {
					if (
						event.source === window &&
						event.data?.source === "opencut-hf-live"
					)
						state.events.push(event.data);
				});
				state.request = (input) =>
					new Promise((resolve, reject) => {
						const current = ++sequence;
						const listener = (event: MessageEvent) => {
							if (
								event.source !== window ||
								event.data?.source !== "opencut-hf-live"
							)
								return;
							if (
								event.data.type === "error" ||
								(event.data.type === "frame" && event.data.sequence === current)
							) {
								clearTimeout(timer);
								window.removeEventListener("message", listener);
								if (event.data.type === "error")
									reject(new Error(event.data.message));
								else resolve();
							}
						};
						const timer = setTimeout(() => {
							window.removeEventListener("message", listener);
							reject(new Error("Playback acknowledgement timed out"));
						}, 3000);
						window.addEventListener("message", listener);
						window.postMessage(
							{
								source: "opencut-hf-live",
								type: "seek",
								sequence: current,
								sampledAt: performance.timeOrigin + performance.now(),
								endTimeSeconds: 4,
								...input,
							},
							"*",
						);
					});
			});
			await page.goto(live.url, { waitUntil: "load" });
			await page.waitForFunction(() =>
				(window as unknown as ParentFixture).events.some(
					(e) => e.type === "ready" || e.type === "error",
				),
			);
			expect(
				await page.evaluate(() =>
					(window as unknown as ParentFixture).events.filter(
						(e) => e.type === "error",
					),
				),
			).toEqual([]);
			const authored = page
				.frames()
				.find((frame) => new URL(frame.url()).pathname === "/index.html")!;
			await authored.evaluate(() => {
				const state = window as unknown as AuthoredFixture;
				state.observed = {
					frames: 0,
					seeks: 0,
					before: 0,
					after: 0,
					starting: false,
					playerSeeks: 0,
				};
				const seek = state.__player.seek.bind(state.__player);
				state.__player.seek = (time) => {
					state.observed.playerSeeks++;
					return seek(time);
				};
				const video = document.querySelector("video")!;
				video.addEventListener("seeking", () => state.observed.seeks++);
				const observe = () =>
					video.requestVideoFrameCallback(() => {
						state.observed.frames++;
						observe();
					});
				observe();
			});
			const read = () =>
				authored.evaluate(() => {
					const state = window as unknown as AuthoredFixture;
					const video = document.querySelector("video")!;
					return {
						time: state.__player.getTime(),
						playing: state.__player.isPlaying(),
						muted: video.muted,
						paused: video.paused,
						sourceTime: video.currentTime,
						...state.observed,
					};
				});
			const wait = (ms: number) =>
				page.evaluate(
					(ms) => new Promise((resolve) => setTimeout(resolve, ms)),
					ms,
				);
			const updates = await page.evaluate(async () => {
				const state = window as unknown as ParentFixture;
				const start = performance.now();
				let updates = 0;
				while (performance.now() - start < 1000) {
					await state.request({
						timeSeconds: 0.75 + (performance.now() - start) / 1000,
						playing: true,
					});
					updates++;
					await new Promise(requestAnimationFrame);
				}
				return updates;
			});
			const running = await read();
			expect(running.playing).toBe(true);
			expect(running.paused).toBe(false);
			expect(running.muted).toBe(true);
			expect(running.frames).toBeGreaterThan(5);
			expect(running.seeks).toBeLessThan(updates / 2);
			expect(
				Math.abs(running.sourceTime - ((running.time - 0.5) * 1.5 + 0.25)),
			).toBeLessThan(0.15);
			// Losing parent updates must stop the internal clock without another message.
			await wait(350);
			const expired = await read();
			expect(expired.playing).toBe(false);
			expect(expired.paused).toBe(true);
			await wait(100);
			expect((await read()).time).toBe(expired.time);
			await page.evaluate(() =>
				(window as unknown as ParentFixture).request({ timeSeconds: 1 }),
			);
			const preparedSeeks = (await read()).playerSeeks;
			await page.evaluate(() =>
				(window as unknown as ParentFixture).request({
					timeSeconds: 1,
					playing: true,
				}),
			);
			// The already prepared frame must start without resetting its decoder.
			expect((await read()).playerSeeks).toBe(preparedSeeks);
			await page.evaluate(() =>
				window.postMessage({ source: "opencut-hf-live", type: "pause" }, "*"),
			);

			// Explicit pause during an asynchronous start must acknowledge the old
			// request without restarting playback after its seek completes.
			await authored.evaluate(() => {
				const state = window as unknown as AuthoredFixture;
				const seek = state.__player.seek.bind(state.__player);
				state.__player.seek = async (time) => {
					state.observed.starting = true;
					await new Promise((resolve) => setTimeout(resolve, 100));
					await seek(time);
					state.__player.seek = seek;
				};
			});
			const starting = page.evaluate(() =>
				(window as unknown as ParentFixture).request({
					timeSeconds: 2,
					playing: true,
				}),
			);
			await authored.waitForFunction(
				() => (window as unknown as AuthoredFixture).observed.starting,
			);
			await page.evaluate(() =>
				window.postMessage({ source: "opencut-hf-live", type: "pause" }, "*"),
			);
			await starting;
			expect((await read()).playing).toBe(false);
			await wait(100);
			expect((await read()).time).toBeCloseTo(2, 1);

			// The occurrence's trimmed end bounds playback even while a longer
			// authored composition remains available.
			await page.evaluate(() =>
				(window as unknown as ParentFixture).request({
					timeSeconds: 2.45,
					endTimeSeconds: 2.5,
					playing: true,
				}),
			);
			await wait(120);
			const ended = await read();
			expect(ended.playing).toBe(false);
			expect(ended.time).toBeLessThan(2.55);

			for (const barrier of ["canvas", "edits"] as const) {
				await authored.evaluate((barrier) => {
					const state = window as unknown as AuthoredFixture;
					if (barrier === "canvas")
						document.body.append(document.createElement("canvas"));
					else
						state.__opencutLayerEdits = {
							beforeSeek: () => state.observed.before++,
							afterSeek: () => state.observed.after++,
						};
				}, barrier);
				await page.evaluate(() =>
					(window as unknown as ParentFixture).request({
						timeSeconds: 1,
						playing: true,
					}),
				);
				const exact = await read();
				expect(exact.playing).toBe(false);
				expect(exact.paused).toBe(true);
				expect(exact.sourceTime).toBeCloseTo(1, 5);
				await wait(100);
				expect((await read()).time).toBe(exact.time);
				if (barrier === "edits")
					expect([exact.before, exact.after]).toEqual([1, 1]);
				await authored.evaluate(() => {
					document.querySelector("canvas")?.remove();
					delete (window as unknown as AuthoredFixture).__opencutLayerEdits;
				});
			}
			// Paused reverse seek after continuous decoding must display the
			// independently decoded source frame, not the previous moving surface.
			await authored.evaluate(async () => {
				const video = document.querySelector("video")!;
				await new Promise<void>((resolve) => {
					video.addEventListener("seeked", () => resolve(), { once: true });
					video.currentTime = 0.995;
				});
			});
			await page.evaluate(() =>
				(window as unknown as ParentFixture).request({ timeSeconds: 1 }),
			);
			expect((await read()).sourceTime).toBeCloseTo(1, 5);
			const pixels = await sharp(
				Buffer.from(
					await page.screenshot({ type: "png", omitBackground: true }),
				),
			)
				.extract({ left: 0, top: 0, width: 96, height: 64 })
				.removeAlpha()
				.raw()
				.toBuffer();
			const decoded = await run(
				process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
				[
					"-v",
					"error",
					"-i",
					videoPath,
					"-vf",
					"select=eq(n\\,30)",
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
			let difference = 0;
			for (let i = 0; i < pixels.length; i++)
				difference += Math.abs(pixels[i] - reference[i]);
			expect(difference / pixels.length).toBeLessThan(2);
			expect(
				await page.evaluate(() =>
					(window as unknown as ParentFixture).events.filter(
						(e) => e.type === "error",
					),
				),
			).toEqual([]);
		} finally {
			if (engine) await closeCaptureSession(engine);
			await host.close();
			runtime.free();
			await unlink(videoPath).catch(() => {});
			await rmdir(directory);
		}
	},
	30_000,
);
