import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser } from "@hyperframes/engine";

declare global {
	interface Window {
		__sourceMediaFixture: typeof import("./source-media-browser-fixture");
	}
}

test("a real drag resolves project media; browser decodes image pixels and audio windows without uploading a source", async () => {
	const bundle = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("./source-media-browser-fixture.ts", import.meta.url),
			),
		],
		target: "browser",
		format: "esm",
		plugins: [
			{
				name: "speech-worker-test-double",
				setup(build) {
					build.onResolve({ filter: /^@\/transcription\/windows$/ }, () => ({
						namespace: "speech-test",
						path: "worker",
					}));
					build.onLoad({ filter: /.*/, namespace: "speech-test" }, () => ({
						loader: "js",
						contents: `export async function transcribeAudioWindows({duration, load}) {
						const pcm = await load();
						if (duration !== 0.8 || pcm.length !== 12800 || !pcm.some(x => x > 0.4)) throw new Error("Wrong speech evidence");
						return {text:"local speech worker fixture"};
					}`,
					}));
				},
			},
		],
	});
	if (!bundle.success) throw new Error(bundle.logs.join("\n"));
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	const requests: string[] = [];
	try {
		const page = await lease.browser.newPage();
		page.on("request", (request) => requests.push(request.url()));
		const observed = await page.evaluate(
			async (code) => {
				const url = URL.createObjectURL(
					new Blob([code], { type: "text/javascript" }),
				);
				try {
					window.__sourceMediaFixture = await import(url);
					return await window.__sourceMediaFixture.observeDroppedMedia();
				} finally {
					URL.revokeObjectURL(url);
				}
			},
			await bundle.outputs[0].text(),
		);
		expect(observed.reference).toEqual({
			projectId: "project",
			mediaId: "photo",
		});
		expect(observed.forgedId).toBeUndefined();
		expect(observed.image).toMatchObject({
			type: "success",
			data: {
				evidence: {
					mode: "image",
					width: 1200,
					height: 600,
					artifactId: "decoded-image",
				},
			},
		});
		expect(observed.preview).toMatchObject({
			width: 1024,
			height: 512,
			stored: 1,
		});
		expect(observed.preview.pixel[1]).toBeGreaterThan(200);
		expect(observed.preview.pixel[0]).toBeLessThan(10);
		expect(observed.stale.type).toBe("rejected");
		expect(observed.foreign.type).toBe("rejected");
		expect(observed.silence).toMatchObject({
			type: "success",
			data: {
				evidence: {
					rms: 0,
					peak: 0,
					startMs: 100,
					endMs: 700,
					transcript: null,
				},
			},
		});
		expect(observed.tone).toMatchObject({
			type: "success",
			data: {
				evidence: {
					mode: "audio",
					startMs: 1200,
					endMs: 2000,
					durationMs: 2000,
					transcript: "local speech worker fixture",
				},
			},
		});
		expect(requests.some((url) => /^https?:/.test(url))).toBe(false);
	} finally {
		await lease.release();
	}
}, 60000);
