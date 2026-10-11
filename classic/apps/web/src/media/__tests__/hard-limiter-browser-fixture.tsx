"use client";
import { useState } from "react";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm/media-time";
import { renderNoiseReducedWindow } from "../noise-reduction";
import type { AudioCapableElement } from "@/timeline/audio-state";

export function HardLimiterBrowserFixture() {
	const [result, setResult] = useState("Ready");
	return (
		<main>
			<h1>Podcast audio verification</h1>
			<button
				onClick={async () => {
					setResult("Running");
					const context = new AudioContext({ sampleRate: 48000 });
					try {
						const sr = 48000,
							source = context.createBuffer(2, sr * 7, sr);
						for (let i = 0; i < source.length; i++) {
							source.getChannelData(0)[i] =
								0.02 * Math.sin((i * 2 * Math.PI * 440) / sr);
							source.getChannelData(1)[i] = source.getChannelData(0)[i] * 0.5;
						}
						for (const i of [sr * 3 - 1, sr * 3 + 1, sr * 5, sr * 5.125 - 1]) {
							source.getChannelData(0)[i] = 2;
							source.getChannelData(1)[i] = 1;
						}
						const element: AudioCapableElement = {
							id: "mic",
							type: "audio",
							name: "Mic",
							sourceType: "upload",
							mediaId: "test",
							startTime: ZERO_MEDIA_TIME,
							duration: mediaTime({ ticks: 4.125 * 120000 }),
							trimStart: mediaTime({ ticks: 120000 }),
							trimEnd: ZERO_MEDIA_TIME,
							params: {
								volume: 15,
								gainDb: -1,
								hardLimiterEnabled: true,
								hardLimiterCeilingDb: -1,
								hardLimiterLookAheadMs: 7,
								hardLimiterReleaseMs: 100,
							},
						};
						const clip = {
							trimStart: 1,
							duration: 4.125,
							timelineElement: element,
						};
						const rows = [];
						for (const amount of [0, 25])
							for (const offset of [0, 2, 4]) {
								const duration = Math.min(2, clip.duration - offset);
								const began = performance.now();
								const full = await renderNoiseReducedWindow({
									audioContext: context,
									clip,
									offset,
									duration,
									amount,
									readSource: async (start) => ({
										buffer: source,
										trimStart: start,
									}),
								});
								const ms = performance.now() - began;
								const ranged = await renderNoiseReducedWindow({
									audioContext: context,
									clip,
									offset,
									duration,
									amount,
									readSource: async (start, end) => {
										const b = context.createBuffer(
											2,
											Math.round((end - start) * sr),
											sr,
										);
										for (let c = 0; c < 2; c++)
											b.copyToChannel(
												source
													.getChannelData(c)
													.subarray(
														Math.round(start * sr),
														Math.round(end * sr),
													),
												c,
											);
										return { buffer: b, trimStart: 0 };
									},
								});
								if (!full || !ranged) throw Error("Missing audio");
								let peak = 0,
									error = 0,
									stereoError = 0;
								for (let i = 0; i < full.length; i++) {
									peak = Math.max(peak, Math.abs(full.getChannelData(0)[i]));
									error = Math.max(
										error,
										Math.abs(
											full.getChannelData(0)[i] - ranged.getChannelData(0)[i],
										),
									);
									stereoError = Math.max(
										stereoError,
										Math.abs(
											full.getChannelData(1)[i] -
												full.getChannelData(0)[i] * 0.5,
										),
									);
								}
								const expected =
									source.getChannelData(0)[sr + 1000] * 10 ** (14 / 20);
								if (
									peak > 10 ** (-1 / 20) + 1e-6 ||
									error > 1e-6 ||
									full.length !== Math.round(duration * sr) ||
									(amount === 0 && stereoError > 1e-6) ||
									(amount === 0 &&
										offset === 0 &&
										Math.abs(full.getChannelData(0)[1000] - expected) > 1e-6)
								)
									throw Error(
										JSON.stringify({
											peak,
											error,
											stereoError,
											expected,
											actual: full.getChannelData(0)[1000],
										}),
									);
								rows.push({
									amount,
									offset,
									duration,
									length: full.length,
									peakDb: 20 * Math.log10(peak),
									maxPreviewExportError: error,
									stereoError,
									milliseconds: ms,
								});
							}
						setResult(JSON.stringify({ status: "PASS", rows }, null, 2));
					} catch (error) {
						setResult(`FAIL ${String(error)}`);
					} finally {
						await context.close();
					}
				}}
			>
				Run audio verification
			</button>
			<pre>{result}</pre>
		</main>
	);
}
