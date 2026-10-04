import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	acquireBrowser,
	buildChromeArgs,
	releaseBrowser,
} from "@hyperframes/engine";

test.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"export mastering preserves sample positions and the final sample across sample rates",
	async () => {
		const built = await Bun.build({
			entrypoints: [
				fileURLToPath(new URL("../audio-mastering.ts", import.meta.url)),
			],
			target: "browser",
			format: "esm",
		});
		expect(built.success).toBe(true);
		const script = await built.outputs[0].text();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(script, {
					headers: {
						"Content-Type": "text/javascript",
						"Access-Control-Allow-Origin": "*",
					},
				}),
		});
		let acquired: Awaited<ReturnType<typeof acquireBrowser>> | undefined;
		try {
			acquired = await acquireBrowser(
				buildChromeArgs(
					{ width: 320, height: 180, captureMode: "screenshot" },
					{ browserGpuMode: "software" },
				),
				{ enableBrowserPool: false },
			);
			const page = await acquired.browser.newPage();
			const results = await page.evaluate(async (url) => {
				const { applyAudioMasteringToBuffer } = await import(url);
				const results = [];
				for (const sampleRate of [22_050, 44_100, 48_000, 96_000]) {
					const source = new AudioBuffer({
						numberOfChannels: 2,
						length: sampleRate,
						sampleRate,
					});
					const firstSample = Math.floor(sampleRate * 0.1);
					source.getChannelData(0)[firstSample] = 0.2;
					source.getChannelData(1)[Math.floor(sampleRate * 0.5)] = 1.1;
					source.getChannelData(0)[sampleRate - 1] = 0.2;
					const rendered: AudioBuffer = await applyAudioMasteringToBuffer({
						audioBuffer: source,
					});
					// Reuse the same rate to exercise the cached latency measurement.
					const repeated: AudioBuffer = await applyAudioMasteringToBuffer({
						audioBuffer: source,
					});
					let peak = 0;
					let repeatError = 0;
					for (let channel = 0; channel < 2; channel++) {
						const data = rendered.getChannelData(channel);
						const repeat = repeated.getChannelData(channel);
						for (let i = 0; i < data.length; i++) {
							peak = Math.max(peak, Math.abs(data[i]));
							repeatError = Math.max(repeatError, Math.abs(data[i] - repeat[i]));
						}
					}
					const low = new AudioBuffer({
						numberOfChannels: 1,
						length: sampleRate,
						sampleRate,
					});
					low.getChannelData(0)[0] = 0.4;
					const bypassed = await applyAudioMasteringToBuffer({ audioBuffer: low });
					results.push({
						sampleRate,
						length: rendered.length,
						channels: rendered.numberOfChannels,
						firstSample,
						firstOutput: rendered.getChannelData(0).findIndex((x) => Math.abs(x) > 1e-6),
						lastOutput: rendered.getChannelData(0).findLastIndex((x) => Math.abs(x) > 1e-6),
						peak,
						repeatError,
						sourceUnchanged: source.getChannelData(1)[Math.floor(sampleRate * 0.5)] > 1,
						bypassed: bypassed === low,
					});
				}
				return results;
			}, `http://127.0.0.1:${server.port}/mastering.js`);
			for (const result of results) {
				expect(result.firstOutput).toBe(result.firstSample);
				expect(result.lastOutput).toBe(result.sampleRate - 1);
				expect(result.length).toBe(result.sampleRate);
				expect(result.channels).toBe(2);
				expect(result.peak).toBeGreaterThan(0.1);
				expect(result.peak).toBeLessThanOrEqual(0.980001);
				expect(result.repeatError).toBe(0);
				expect(result.sourceUnchanged).toBe(true);
				expect(result.bypassed).toBe(true);
			}
		} finally {
			if (acquired)
				await releaseBrowser(acquired.browser, { enableBrowserPool: false });
			server.stop(true);
		}
	},
	30_000,
);
