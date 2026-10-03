import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { buildChromeArgs } from "@hyperframes/engine";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesCaptureSession } from "../capture-session";
import { HyperframesPreviewHost } from "../preview-host";
import type { HyperframesSource } from "../types";

function fixture({
	background = "transparent",
}: { background?: string } = {}): HyperframesSource {
	return {
		entryFile: "scenes/scene.html",
		files: {
			"scenes/scene.html": `<!doctype html><html><head><style>
html,body{margin:0;width:320px;height:180px;background:${background}}
[data-composition-id="main"]{position:relative;width:320px;height:180px}
.square{position:absolute;top:20px;left:0;width:40px;height:40px;background:var(--paint);animation:move 4s linear both}
@keyframes move{from{transform:translateX(0)}to{transform:translateX(160px)}}
</style></head><body><div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="4">
<div class="square"></div><div data-composition-id="child" data-no-timeline data-composition-src="child.html" data-start="0" data-duration="4"></div>
</div><script>
window.__hf=window.__hf||{};
window.__hf.buildReady={data:fetch("data.json").then(r=>r.json()).then(data=>document.documentElement.style.setProperty("--paint",data.color))};
</script></body></html>`,
			"scenes/data.json": '{"color":"rgb(255,0,0)"}',
			"scenes/child.html":
				'<template><div data-composition-id="child" data-no-timeline data-width="320" data-height="180" data-duration="4"><div style="position:absolute;left:250px;top:120px;width:20px;height:20px;background:rgb(0,255,0)"></div></div></template>',
		},
		resourceAssetIds: {},
	};
}

test("the pinned capture engine retains Chrome's sandbox", () => {
	const args = buildChromeArgs(
		{ width: 320, height: 180, captureMode: "screenshot" },
		{ browserGpuMode: "software" },
	);
	expect(args).not.toContain("--no-sandbox");
	expect(args).not.toContain("--disable-setuid-sandbox");
	expect(args).not.toContain("--disable-web-security");
});

test("failed preparation releases its capture slot without starting Chrome", async () => {
	const runtime = await createCanonicalTestRuntime();
	const host = new HyperframesPreviewHost();
	try {
		for (let attempt = 0; attempt < 6; attempt++) {
			const source = fixture();
			source.resourceAssetIds["missing.png"] = "missing-resource";
			await expect(
				HyperframesCaptureSession.open({
					source,
					resources: new Map(),
					runtime,
					host,
				}),
			).rejects.toThrow("Missing HyperFrames resource");
		}
	} finally {
		await host.close();
		runtime.free();
	}
});

describe.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"real HyperFrames capture",
	() => {
		test("captures nested entry paths, CSS time, dynamic data and alpha through the ArtifactStore", async () => {
			const runtime = await createCanonicalTestRuntime();
			const host = new HyperframesPreviewHost();
			let session: HyperframesCaptureSession | undefined;
			try {
				session = await HyperframesCaptureSession.open({
					source: fixture(),
					resources: new Map(),
					runtime,
					host,
					chromePath: process.env.OPENCUT_HYPERFRAMES_CHROME_PATH,
				});
				expect(session.durationSeconds).toBe(4);
				const first = await session.capture({ timeSeconds: 0.5 });
				const later = await session.capture({ timeSeconds: 2 });
				const reverse = await session.capture({ timeSeconds: 0.5 });
				expect(first.sha256).toBe(reverse.sha256);
				expect(later.sha256).not.toBe(first.sha256);
				const firstBytes = runtime.readArtifact(first.uri);
				expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(
					first.sha256,
				);
				expect(first.mimeType).toBe("image/png");
				expect(first.byteSize).toBe(firstBytes.byteLength);
				expect([first.width, first.height]).toEqual([320, 180]);
				const early = await sharp(firstBytes).ensureAlpha().raw().toBuffer();
				const late = await sharp(runtime.readArtifact(later.uri))
					.ensureAlpha()
					.raw()
					.toBuffer();
				const pixel = ({
					pixels,
					x,
					y,
				}: {
					pixels: Buffer;
					x: number;
					y: number;
				}) => [...pixels.subarray((y * 320 + x) * 4, (y * 320 + x) * 4 + 4)];
				expect(pixel({ pixels: early, x: 25, y: 25 })).toEqual([
					255, 0, 0, 255,
				]);
				expect(pixel({ pixels: late, x: 85, y: 25 })).toEqual([255, 0, 0, 255]);
				expect(pixel({ pixels: late, x: 25, y: 25 })[3]).toBe(0);
				expect(pixel({ pixels: early, x: 255, y: 125 })).toEqual([
					0, 255, 0, 255,
				]);
				expect(pixel({ pixels: early, x: 310, y: 170 })[3]).toBe(0);
				const queuedEarly = session.capture({ timeSeconds: 0.5 });
				const queuedLate = session.capture({ timeSeconds: 2 });
				await expect(session.capture({ timeSeconds: 1 })).rejects.toThrow(
					"queue is full",
				);
				const [earlyResult, lateResult] = await Promise.all([
					queuedEarly,
					queuedLate,
				]);
				expect(earlyResult.sha256).toBe(first.sha256);
				expect(lateResult.sha256).toBe(later.sha256);
				await expect(session.capture({ timeSeconds: 4 })).rejects.toThrow(
					"inside",
				);
				await expect(
					session.capture({ timeSeconds: Number.NaN }),
				).rejects.toThrow("inside");
				await expect(
					session.capture({ timeSeconds: 0, signal: AbortSignal.abort() }),
				).rejects.toThrow();
				expect(session.isClosed).toBe(false);
				await Promise.all([session.close(), session.close()]);
				expect(session.isClosed).toBe(true);
				await expect(session.capture({ timeSeconds: 0 })).rejects.toThrow(
					"closed",
				);
				// Closing a capture does not invalidate an already returned artifact.
				expect(runtime.readArtifact(first.uri)).toEqual(firstBytes);
			} finally {
				await session?.close();
				await host.close();
				runtime.free();
			}
		}, 90_000);

		test("preserves authored body backgrounds and cancels active capture", async () => {
			const runtime = await createCanonicalTestRuntime();
			const host = new HyperframesPreviewHost();
			let session: HyperframesCaptureSession | undefined;
			try {
				session = await HyperframesCaptureSession.open({
					source: fixture({ background: "rgb(17,34,51)" }),
					resources: new Map(),
					runtime,
					host,
					chromePath: process.env.OPENCUT_HYPERFRAMES_CHROME_PATH,
				});
				const frame = await session.capture({ timeSeconds: 0.5 });
				const pixels = await sharp(runtime.readArtifact(frame.uri))
					.ensureAlpha()
					.raw()
					.toBuffer();
				expect([
					...pixels.subarray((170 * 320 + 310) * 4, (170 * 320 + 310) * 4 + 4),
				]).toEqual([17, 34, 51, 255]);
				const cancellation = new AbortController();
				const cancelled = session.capture({
					timeSeconds: 2,
					signal: cancellation.signal,
				});
				const timer = setTimeout(() => cancellation.abort(), 1);
				try {
					await expect(cancelled).rejects.toThrow();
				} finally {
					clearTimeout(timer);
				}
				expect(session.isClosed).toBe(true);
			} finally {
				await session?.close();
				await host.close();
				runtime.free();
			}
		}, 90_000);
	},
);
