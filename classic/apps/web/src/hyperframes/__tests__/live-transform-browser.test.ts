/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Isolated Chrome fixture state is installed and consumed within this test. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCaptureSession,
	closeCaptureSession,
	type CaptureSession,
} from "@hyperframes/engine";
import sharp from "sharp";
import { hyperframesLiveTransform } from "../live-transform";
import type { QuadTransformDescriptor } from "@/services/renderer/compositor/types";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"live CSS perspective matches the actual WASM compositor across rotation, flips and opacity",
	async () => {
		const assets = new Map([
			[
				"/opencut_wasm_bg.js",
				{
					type: "text/javascript",
					bytes: readFileSync(
						new URL(
							"../../../../../rust/wasm/pkg/opencut_wasm_bg.js",
							import.meta.url,
						),
					),
				},
			],
			[
				"/opencut_wasm_bg.wasm",
				{
					type: "application/wasm",
					bytes: readFileSync(
						new URL(
							"../../../../../rust/wasm/pkg/opencut_wasm_bg.wasm",
							import.meta.url,
						),
					),
				},
			],
		]);
		const server = createServer((request, response) => {
			const asset = assets.get(request.url ?? "");
			if (asset) {
				response.writeHead(200, { "Content-Type": asset.type });
				response.end(asset.bytes);
				return;
			}
			response.writeHead(request.url === "/" ? 200 : 404, {
				"Content-Type": "text/html",
			});
			response.end("<!doctype html><html><body></body></html>");
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing test address");
		const origin = `http://127.0.0.1:${address.port}`;
		const directory = await mkdtemp(join(tmpdir(), "opencut-hf-projection-"));
		let engine: CaptureSession | undefined;
		try {
			engine = await createCaptureSession(
				origin,
				directory,
				{
					entryUrl: origin,
					width: 320,
					height: 240,
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
			await page.goto(origin);
			await page.evaluate(async (origin) => {
				const glue = (await import(
					`${origin}/opencut_wasm_bg.js`
				)) as typeof import("opencut-wasm") & {
					__wbg_set_wasm(exports: WebAssembly.Exports): void;
				};
				const { instance } = await WebAssembly.instantiate(
					await (await fetch(`${origin}/opencut_wasm_bg.wasm`)).arrayBuffer(),
					{ "./opencut_wasm_bg.js": glue },
				);
				glue.__wbg_set_wasm(instance.exports);
				const start = instance.exports.__wbindgen_start;
				if (typeof start !== "function")
					throw new Error("Missing WASM startup export");
				start();
				await glue.initializeGpu();
				glue.initCompositor(320, 240);
				const compositor = glue.getCompositorCanvas();
				const source = new OffscreenCanvas(160, 120);
				const context = source.getContext("2d")!;
				for (const [index, color] of [
					"#e02040",
					"#10b060",
					"#2050d0",
					"#f0c030",
				].entries()) {
					context.fillStyle = color;
					context.fillRect(
						(index % 2) * 80,
						Math.floor(index / 2) * 60,
						80,
						60,
					);
				}
				glue.uploadTexture({ id: "pattern", source, width: 160, height: 120 });
				const readback = new OffscreenCanvas(320, 240);
				const output = readback.getContext("2d")!;
				document.documentElement.style.background = "transparent";
				document.body.style.cssText =
					"margin:0;background:transparent;overflow:hidden;width:320px;height:240px";
				const frame = document.createElement("iframe");
				frame.style.cssText =
					"position:absolute;border:0;width:160px;height:120px;transform-origin:center;background:transparent";
				frame.srcdoc =
					'<style>html,body{margin:0;background:transparent;overflow:hidden}</style><svg width="160" height="120" xmlns="http://www.w3.org/2000/svg"><path fill="#e02040" d="M0 0h80v60H0z"/><path fill="#10b060" d="M80 0h80v60H80z"/><path fill="#2050d0" d="M0 60h80v60H0z"/><path fill="#f0c030" d="M80 60h80v60H80z"/></svg>';
				const loaded = new Promise<void>((resolve) => {
					frame.onload = () => resolve();
				});
				document.body.appendChild(frame);
				await loaded;
				const render = async ({
					quad,
					opacity,
					transform,
				}: {
					quad: QuadTransformDescriptor;
					opacity: number;
					transform: string;
				}) => {
					frame.style.left = `${quad.centerX}px`;
					frame.style.top = `${quad.centerY}px`;
					frame.style.transform = transform;
					frame.style.opacity = String(opacity);
					glue.renderFrame({
						width: 320,
						height: 240,
						clear: { color: [0, 0, 0, 0] },
						items: [
							{
								type: "layer",
								textureId: "pattern",
								transform: quad,
								opacity,
								blendMode: "normal",
								mask: null,
								effectPassGroups: [],
							},
						],
					});
					output.clearRect(0, 0, 320, 240);
					output.drawImage(compositor, 0, 0);
					const pixels = Array.from(output.getImageData(0, 0, 320, 240).data);
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					return pixels;
				};
				Object.assign(window, { projectionFixture: { render } });
			}, origin);
			const base: QuadTransformDescriptor = {
				centerX: 160,
				centerY: 120,
				width: 200,
				height: 150,
				rotationDegrees: 0,
				perspectiveXDegrees: 0,
				perspectiveYDegrees: 0,
				flipX: false,
				flipY: false,
			};
			const cases: Array<{
				name: string;
				quad: Partial<QuadTransformDescriptor>;
				opacity?: number;
			}> = [
				{ name: "flat", quad: {} },
				{ name: "x tilt", quad: { perspectiveXDegrees: 20 } },
				{ name: "y tilt", quad: { perspectiveYDegrees: -35 } },
				{
					name: "combined rotation",
					quad: {
						perspectiveXDegrees: 35,
						perspectiveYDegrees: -25,
						rotationDegrees: 17,
					},
				},
				{
					name: "horizontal flip",
					quad: {
						perspectiveXDegrees: -30,
						perspectiveYDegrees: 50,
						flipX: true,
					},
				},
				{
					name: "vertical flip",
					quad: {
						perspectiveXDegrees: 60,
						perspectiveYDegrees: -15,
						rotationDegrees: -35,
						flipY: true,
					},
				},
				{
					name: "both flips",
					quad: {
						perspectiveXDegrees: -40,
						perspectiveYDegrees: -55,
						rotationDegrees: 70,
						flipX: true,
						flipY: true,
					},
				},
				{
					name: "nonuniform and translucent",
					quad: {
						width: 260,
						height: 60,
						perspectiveXDegrees: 40,
						perspectiveYDegrees: 25,
						rotationDegrees: -20,
					},
					opacity: 0.42,
				},
				{
					name: "portrait",
					quad: {
						width: 80,
						height: 180,
						perspectiveXDegrees: 25,
						perspectiveYDegrees: -30,
						centerX: 140,
						centerY: 110,
					},
				},
				{
					name: "limit",
					quad: { perspectiveXDegrees: 75, perspectiveYDegrees: -75 },
				},
			];
			for (const entry of cases) {
				const quad = { ...base, ...entry.quad };
				const input = {
					quad,
					opacity: entry.opacity ?? 1,
					transform: hyperframesLiveTransform({
						quad,
						sourceWidth: 160,
						sourceHeight: 120,
					}),
				};
				const expected = await page.evaluate(
					(input) =>
						(
							window as unknown as {
								projectionFixture: {
									render(value: {
										quad: QuadTransformDescriptor;
										opacity: number;
										transform: string;
									}): Promise<number[]>;
								};
							}
						).projectionFixture.render(input),
					input,
				);
				const actual = await sharp(
					await page.screenshot({ type: "png", omitBackground: true }),
				)
					.ensureAlpha()
					.raw()
					.toBuffer();
				expect(actual.length).toBe(expected.length);
				let absolute = 0;
				let different = 0;
				let painted = 0;
				for (let p = 0; p < expected.length; p += 4) {
					let max = 0;
					for (let c = 0; c < 4; c++) {
						// Compare premultiplied color so antialiased transparent edges do not dominate.
						const a =
							c === 3 ? actual[p + c] : (actual[p + c] * actual[p + 3]) / 255;
						const b =
							c === 3
								? expected[p + c]
								: (expected[p + c] * expected[p + 3]) / 255;
						const delta = Math.abs(a - b);
						absolute += delta;
						max = Math.max(max, delta);
					}
					if (max > 8) different++;
					if (expected[p + 3]) painted++;
				}
				const metrics = {
					name: entry.name,
					meanError: absolute / expected.length,
					differentFraction: different / (320 * 240),
					painted,
				};
				console.info("projection parity", JSON.stringify(metrics));
				expect(painted).toBeGreaterThan(1000);
				expect(metrics.meanError).toBeLessThan(1.5);
				expect(metrics.differentFraction).toBeLessThan(0.03);
			}
		} finally {
			if (engine) await closeCaptureSession(engine);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rmdir(directory);
		}
	},
	90_000,
);
