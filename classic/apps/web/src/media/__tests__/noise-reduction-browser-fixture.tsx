"use client";
import { useState } from "react";
import { renderNoiseReducedWindow } from "../noise-reduction";

// Interactive regression harness: use a browser with actual Web Audio and the
// production worker/WASM, without a second editor state store.
export function NoiseReductionBrowserFixture() {
	const [result, setResult] = useState("Ready");
	return (
		<main>
			<h1>Noise reduction browser verification</h1>
			<button
				onClick={async () => {
					setResult("Running");
					const context = new AudioContext({ sampleRate: 48000 });
					try {
						const source = context.createBuffer(2, 48000 * 7, 48000);
						let seed = 42;
						for (let i = 0; i < source.length; i++) {
							seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
							source.getChannelData(0)[i] =
								((seed >>> 8) / 16777216 - 0.5) * 0.06;
						}
						const clip = { trimStart: 1, duration: 4.125 };
						const rows = [];
						for (const offset of [0, 2, 4]) {
							const duration = Math.min(2, clip.duration - offset);
							const began = performance.now();
							const full = await renderNoiseReducedWindow({
								audioContext: context,
								clip,
								offset,
								duration,
								amount: 100,
								readSource: async (start) => ({
									buffer: source,
									trimStart: start,
								}),
							});
							const milliseconds = performance.now() - began;
							const ranged = await renderNoiseReducedWindow({
								audioContext: context,
								clip,
								offset,
								duration,
								amount: 100,
								readSource: async (start, end) => {
									const buffer = context.createBuffer(
										2,
										Math.round((end - start) * 48000),
										48000,
									);
									for (let c = 0; c < 2; c++)
										buffer.copyToChannel(
											source
												.getChannelData(c)
												.subarray(
													Math.round(start * 48000),
													Math.round(end * 48000),
												),
											c,
										);
									return { buffer, trimStart: 0 };
								},
							});
							if (!full || !ranged) throw new Error("Missing buffer");
							let maxError = 0,
								energy = 0,
								dryEnergy = 0,
								silentChannel = 0;
							for (let i = 0; i < full.length; i++) {
								maxError = Math.max(
									maxError,
									Math.abs(
										full.getChannelData(0)[i] - ranged.getChannelData(0)[i],
									),
								);
								energy += full.getChannelData(0)[i] ** 2;
								dryEnergy +=
									source.getChannelData(0)[
										Math.round((clip.trimStart + offset) * 48000) + i
									] ** 2;
								silentChannel = Math.max(
									silentChannel,
									Math.abs(full.getChannelData(1)[i]),
								);
							}
							rows.push({
								offset,
								duration,
								length: full.length,
								milliseconds,
								maxError,
								noiseEnergyRatio: energy / dryEnergy,
								silentChannel,
							});
						}
						if (
							rows.some(
								(r) =>
									r.maxError > 1e-6 ||
									r.silentChannel !== 0 ||
									r.length !== Math.round(r.duration * 48000),
							)
						)
							throw new Error(JSON.stringify(rows));
						setResult(JSON.stringify({ status: "PASS", rows }, null, 2));
					} catch (error) {
						setResult(`FAIL ${String(error)}`);
					} finally {
						await context.close();
					}
				}}
			>
				Run verification
			</button>
			<pre>{result}</pre>
		</main>
	);
}
