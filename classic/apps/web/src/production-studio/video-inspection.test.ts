import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireBrowser } from "@hyperframes/engine";
declare global {
	interface Window {
		__productionVideoFixture: typeof import("./video-inspection-fixture");
	}
}
test("source video frames decode locally, preserve actual timestamps/colors and reject stale scope before storing", async () => {
	const temp = await mkdtemp(join(tmpdir(), "pocut-source-video-"));
	const path = join(temp, "fixture.webm");
	const ffmpeg = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=red:s=960x540:r=10:d=1",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=960x540:r=10:d=1",
			"-filter_complex",
			"[0:v][1:v]concat=n=2:v=1:a=0[v]",
			"-map",
			"[v]",
			"-c:v",
			"libvpx-vp9",
			"-threads",
			"1",
			"-y",
			path,
		],
		{ stdout: "ignore", stderr: "pipe" },
	);
	expect(await ffmpeg.exited).toBe(0);
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(new URL("./video-inspection-fixture.ts", import.meta.url)),
		],
		target: "browser",
		format: "esm",
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(`${request.method} ${url.pathname}`);
			if (url.pathname === "/fixture.js")
				return new Response(bundle.outputs[0], {
					headers: { "Content-Type": "text/javascript" },
				});
			if (url.pathname === "/video.webm") return new Response(Bun.file(path));
			return new Response(
				"<html><body>Production source video QA</body></html>",
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	try {
		const page = await lease.browser.newPage();
		await page.goto(`http://localhost:${server.port}`);
		await page.evaluate(async () => {
			const source = "/fixture.js";
			window.__productionVideoFixture = await import(source);
		});
		const success = await page.evaluate(() =>
			window.__productionVideoFixture.inspectVideoFixture("success"),
		);
		expect(success.result.type).toBe("success");
		expect(success.stored).toBe(2);
		if (success.result.type === "success")
			expect(success.result.data).toMatchObject({
				durationMs: 2000,
				width: 960,
				height: 540,
				frames: [{ timeMs: 250 }, { timeMs: 1250 }],
			});
		for (const sample of success.samples) {
			expect(sample.width).toBe(640);
			expect(sample.height).toBe(360);
			expect(sample.bytes).toBeLessThan(180000);
		}
		expect(success.samples[0]!.pixel[0]).toBeGreaterThan(230);
		expect(success.samples[0]!.pixel[2]).toBeLessThan(20);
		expect(success.samples[1]!.pixel[2]).toBeGreaterThan(230);
		expect(success.samples[1]!.pixel[0]).toBeLessThan(20);
		for (const mode of ["account", "revision", "cancel", "range"] as const) {
			const value = await page.evaluate(
				(input) => window.__productionVideoFixture.inspectVideoFixture(input),
				mode,
			);
			expect(value.result.type).toBe("rejected");
			expect(value.stored).toBe(0);
		}
		expect(
			requests.every(
				(request) => request.startsWith("GET ") && !request.includes("/api/"),
			),
		).toBe(true);
	} finally {
		server.stop();
		await lease.release();
		await rm(temp, { recursive: true, force: true });
	}
}, 60000);
