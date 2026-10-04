import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import { HyperframesCaptureSession } from "../capture-session";
import { HyperframesPreviewHost } from "../preview-host";
import { HyperframesRenderHost } from "../render-host";
import { renderHyperframesAudio } from "../audio-render";
import type { HyperframesSource } from "../types";

function tone(): Buffer {
	const wav = Buffer.alloc(44 + 6 * 8000 * 2);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(wav.length - 8, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(8000, 24);
	wav.writeUInt32LE(16000, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(wav.length - 44, 40);
	for (let sample = 0; sample < 6 * 8000; sample++)
		wav.writeInt16LE(
			Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 440 * sample) / 8000)),
			44 + sample * 2,
		);
	return wav;
}

describe.skipIf(process.env.OPENCUT_HYPERFRAMES_BROWSER_TESTS !== "1")(
	"real audio plan probe",
	() => {
		test("discovers undeclared video audio and ignores a looping silent video", async () => {
			const folder = await mkdtemp(
				join(tmpdir(), "opencut-hf-video-audio-test-"),
			);
			const runtime = await createCanonicalTestRuntime();
			const host = new HyperframesPreviewHost();
			let session: HyperframesCaptureSession | undefined;
			try {
				for (const audible of [true, false]) {
					const args = [
						"-v",
						"error",
						"-f",
						"lavfi",
						"-i",
						"color=c=black:s=64x64:r=10:d=2",
					];
					if (audible)
						args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=2");
					args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
					if (audible) args.push("-c:a", "aac");
					args.push("-y", join(folder, audible ? "voice.mp4" : "silent.mp4"));
					const child = Bun.spawn(
						[process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg", ...args],
						{ stdout: "pipe", stderr: "pipe" },
					);
					const error = await new Response(child.stderr).text();
					if (await child.exited) throw new Error(error);
				}
				const source: HyperframesSource = {
					entryFile: "index.html",
					resourceAssetIds: { "voice.mp4": "voice", "silent.mp4": "silent" },
					files: {
						"index.html": `<!doctype html><html><body><div data-composition-id="main" data-no-timeline data-width="64" data-height="64" data-duration="2"><video id="voice" src="voice.mp4" data-start="0" data-duration="2"></video><video id="silent" src="silent.mp4" data-start="0" data-duration="2" loop></video></div></body></html>`,
					},
				};
				const resources = new Map(
					await Promise.all(
						["voice.mp4", "silent.mp4"].map(
							async (name) =>
								[
									name,
									{
										path: join(folder, name),
										mimeType: "video/mp4",
										size: await Bun.file(join(folder, name)).size,
									},
								] as const,
						),
					),
				);
				session = await HyperframesCaptureSession.open({
					source,
					resources,
					runtime,
					host,
				});
				const plan = await session.consumeAudioPlan({ source });
				expect(plan.elements).toHaveLength(2);
				expect(plan.elements.every((element) => element.type === "video")).toBe(
					true,
				);
				expect(
					plan.elements.find((element) => element.src === "silent.mp4")
						?.looping,
				).toBe(true);
				const artifact = await renderHyperframesAudio({
					source,
					plan,
					resources,
					runtime,
				});
				expect(artifact?.mimeType).toBe("audio/mp4");
				expect(artifact?.byteSize).toBeGreaterThan(10_000);
				const audible = plan.elements.find(
					(element) => element.src === "voice.mp4",
				)!;
				audible.looping = true;
				await expect(
					renderHyperframesAudio({ source, plan, resources, runtime }),
				).rejects.toThrow("Looped HyperFrames audio");
			} finally {
				await session?.close();
				await host.close();
				runtime.free();
				await rm(folder, { recursive: true, force: true });
			}
		}, 60_000);
		test("retains nested occurrences, groups, offsets and fades while dropping authored mute", async () => {
			const folder = await mkdtemp(join(tmpdir(), "opencut-hf-audio-test-"));
			const path = join(folder, "voice.wav");
			const wav = tone();
			await writeFile(path, wav);
			const runtime = await createCanonicalTestRuntime();
			const host = new HyperframesPreviewHost();
			const source: HyperframesSource = {
				entryFile: "main.html",
				files: {
					"main.html": `<!doctype html><html><body><div data-composition-id="main" data-no-timeline data-width="320" data-height="180" data-duration="6">
<div id="first" data-composition-id="first" data-no-timeline data-composition-src="child.html" data-start="0" data-duration="3"></div>
<div id="second" data-composition-id="second" data-no-timeline data-composition-src="child.html" data-start="3" data-duration="3"></div>
<audio id="muted" src="voice.wav" data-start="0" data-duration="6" muted loop></audio>
</div></body></html>`,
					"child.html": `<template><div data-composition-id="child" data-no-timeline data-duration="3">
<hf-audio-group id="bus" data-volume="0.75"></hf-audio-group>
<audio id="voice" src="/voice.wav" data-audio-group="bus" data-start="0.5" data-duration="2" data-media-start="0.25" data-playback-rate="2" data-volume="0.5" data-fade-in="0.2" data-fade-out="0.3"></audio>
</div></template>`,
				},
				resourceAssetIds: { "voice.wav": "voice" },
			};
			let session: HyperframesCaptureSession | undefined;
			try {
				session = await HyperframesCaptureSession.open({
					source,
					runtime,
					host,
					resources: new Map([
						["voice.wav", { path, mimeType: "audio/wav", size: wav.length }],
					]),
				});
				const plan = await session.consumeAudioPlan({ source });
				expect(session.isClosed).toBe(true);
				expect(plan.durationSeconds).toBe(6);
				expect(plan.elements).toHaveLength(2);
				expect(plan.elements.map((element) => element.start)).toEqual([
					0.5, 3.5,
				]);
				expect(plan.elements.map((element) => element.end)).toEqual([2.5, 5.5]);
				expect(plan.elements.map((element) => element.id)).toEqual([
					"track-0",
					"track-1",
				]);
				for (const element of plan.elements) {
					expect(element.src).toBe("voice.wav");
					expect(element.mediaStart).toBe(0.25);
					expect(element.playbackRate).toBe(2);
					expect(element.volume).toBe(0.5);
					expect(element.fadeIn).toBe(0.2);
					expect(element.fadeOut).toBe(0.3);
					expect(element.groupVolume).toBe(0.75);
				}
				expect(plan.elements[0].groupId).not.toBe(plan.elements[1].groupId);
				const artifact = await renderHyperframesAudio({
					source,
					plan,
					runtime,
					resources: new Map([
						["voice.wav", { path, mimeType: "audio/wav", size: wav.length }],
					]),
				});
				expect(artifact?.mimeType).toBe("audio/mp4");
				expect(artifact?.durationMs).toBe(6000);
				expect(artifact?.byteSize).toBeGreaterThan(1000);
				const mixed = join(folder, "mixed.m4a");
				await writeFile(mixed, runtime.readArtifact(artifact!.id));
				const decode = Bun.spawn(
					[
						process.env.HYPERFRAMES_FFMPEG_PATH || "ffmpeg",
						"-v",
						"error",
						"-i",
						mixed,
						"-af",
						"pan=mono|c0=c0",
						"-f",
						"f32le",
						"-ar",
						"8000",
						"pipe:1",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const pcm = new Float32Array(
					await new Response(decode.stdout).arrayBuffer(),
				);
				expect(await decode.exited).toBe(0);
				const rms = ({ start, end }: { start: number; end: number }) => {
					const samples = pcm.slice(start * 8000, end * 8000);
					return Math.sqrt(
						samples.reduce((sum, value) => sum + value * value, 0) /
							samples.length,
					);
				};
				expect(pcm.length / 8000).toBeCloseTo(6, 1);
				expect(rms({ start: 0, end: 0.3 })).toBeLessThan(0.002);
				expect(rms({ start: 2.7, end: 3.2 })).toBeLessThan(0.002);
				expect(rms({ start: 1, end: 1.5 })).toBeGreaterThan(0.09);
				expect(rms({ start: 1, end: 1.5 })).toBeLessThan(0.12);
				expect(rms({ start: 4, end: 4.5 })).toBeCloseTo(
					rms({ start: 1, end: 1.5 }),
					2,
				);
				const renderHost = new HyperframesRenderHost(runtime);
				const scope = { accountId: "audio-a", projectId: "project-a" };
				try {
					const ready = await renderHost.open({
						scope,
						source,
						resolveResource: async () => ({
							path,
							mimeType: "audio/wav",
							size: wav.length,
						}),
					});
					const [first, second] = await Promise.all([
						renderHost.audio({ scope, id: ready.id }),
						renderHost.audio({ scope, id: ready.id }),
					]);
					expect(first?.id).toBe(second?.id);
					expect(first?.mimeType).toBe("audio/mp4");
					for (const wrong of [
						{ ...scope, accountId: "audio-b" },
						{ ...scope, projectId: "project-b" },
					]) {
						expect(() =>
							renderHost.readArtifact({ scope: wrong, id: first!.id }),
						).toThrow("unavailable");
					}
					expect(
						(await renderHost.capture({ scope, id: ready.id, timeSeconds: 1 }))
							.mimeType,
					).toBe("image/png");
					const abort = new AbortController();
					abort.abort();
					await expect(
						renderHost.audio({ scope, id: ready.id, signal: abort.signal }),
					).rejects.toThrow();
				} finally {
					await renderHost.close();
				}
				const overhang = structuredClone(source);
				overhang.files["child.html"] = overhang.files["child.html"].replace(
					'data-duration="2" data-media-start',
					'data-duration="2.6" data-media-start',
				);
				const overhangProbe = await HyperframesCaptureSession.open({
					source: overhang,
					runtime,
					host,
					resources: new Map([
						["voice.wav", { path, mimeType: "audio/wav", size: wav.length }],
					]),
				});
				await expect(
					overhangProbe.consumeAudioPlan({ source: overhang }),
				).rejects.toThrow("outside a nested composition window");
			} finally {
				await session?.close();
				await host.close();
				runtime.free();
				await rm(folder, { recursive: true, force: true });
			}
		}, 60_000);

		test.skipIf(!process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE)(
			"samples GSAP volume automation with the official helper",
			async () => {
				const folder = await mkdtemp(
					join(tmpdir(), "opencut-hf-envelope-test-"),
				);
				const path = join(folder, "voice.wav");
				const wav = tone();
				await writeFile(path, wav);
				const runtime = await createCanonicalTestRuntime();
				const host = new HyperframesPreviewHost();
				const source: HyperframesSource = {
					entryFile: "index.html",
					resourceAssetIds: { "voice.wav": "voice" },
					files: {
						"gsap.js": await Bun.file(
							process.env.OPENCUT_HYPERFRAMES_GSAP_FIXTURE!,
						).text(),
						"index.html": `<!doctype html><html><head><script src="gsap.js"></script></head><body><div data-composition-id="main" data-width="64" data-height="64" data-duration="2"><audio id="voice" src="voice.wav" data-start="0" data-duration="2" data-volume="0.2"></audio></div><script>window.__timelines=window.__timelines||{};const tl=gsap.timeline({paused:true});tl.fromTo('#voice',{volume:0.2},{volume:1.2,duration:1,ease:'none'},0.5);tl.to({}, {duration:0.5},1.5);window.__timelines.main=tl;</script></body></html>`,
					},
				};
				let session: HyperframesCaptureSession | undefined;
				try {
					session = await HyperframesCaptureSession.open({
						source,
						runtime,
						host,
						resources: new Map([
							["voice.wav", { path, mimeType: "audio/wav", size: wav.length }],
						]),
					});
					const plan = await session.consumeAudioPlan({ source });
					const frames = plan.elements[0].volumeKeyframes!;
					expect(frames.length).toBeGreaterThan(20);
					expect(frames[0]).toEqual({ time: 0, volume: 0.2 });
					expect(
						frames.find((frame) => frame.time === 0.5)?.volume,
					).toBeCloseTo(0.2, 3);
					expect(frames.find((frame) => frame.time === 1)?.volume).toBeCloseTo(
						0.7,
						3,
					);
					expect(
						frames.find((frame) => frame.time === 1.5)?.volume,
					).toBeCloseTo(1.2, 3);
					expect(frames.at(-1)).toEqual({ time: 2, volume: 1.2 });
				} finally {
					await session?.close();
					await host.close();
					runtime.free();
					await rm(folder, { recursive: true, force: true });
				}
			},
			60_000,
		);
	},
);
