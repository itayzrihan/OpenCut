/* eslint-disable opencut/prefer-object-params -- Synthetic audio fixture and platform callback signatures. */
import { prepareExportAudio } from "../audio-stream";
import { ExportScratch } from "../scratch";
import { DiskExportTarget } from "../disk-target";
import { PcmFile } from "../pcm-file";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { RootNode } from "@/services/renderer/nodes/root-node";
import { createTimelineAudioBuffer, type AudioClipSource } from "@/media/audio";
import type { SceneTracks } from "@/timeline";
import { mediaTime } from "@/wasm";
import {
	AudioBufferSink,
	VideoSampleSink,
	ALL_FORMATS,
	BlobSource,
	Input,
	Output,
	Mp4OutputFormat,
	VideoSampleSource,
	VideoSample,
	EncodedVideoPacketSource,
} from "mediabunny";
import type { EncodedPacket, VideoEncodingConfig } from "mediabunny";

const tracks: SceneTracks = {
	main: {
		id: "v",
		name: "v",
		type: "video",
		elements: [],
		hidden: false,
		muted: false,
	},
	audio: [],
	overlay: [],
};
function wav(sampleRate: number) {
	const frames = sampleRate * 9,
		data = new ArrayBuffer(44 + frames * 4),
		view = new DataView(data);
	const text = (offset: number, value: string) =>
		[...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
	text(0, "RIFF");
	view.setUint32(4, data.byteLength - 8, true);
	text(8, "WAVEfmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 3, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 4, true);
	view.setUint16(32, 4, true);
	view.setUint16(34, 32, true);
	text(36, "data");
	view.setUint32(40, frames * 4, true);
	for (let i = 0; i < frames; i++) {
		const t = i / sampleRate;
		view.setFloat32(
			44 + i * 4,
			(t > 3 && t < 3.1 ? 1.2 : 0.3) *
				Math.sin(t * 2 * Math.PI * (t < 4 ? 440 : 1234)),
			true,
		);
	}
	return new File([data], "tone.wav", { type: "audio/wav" });
}
function clip(
	file: File,
	params: Record<string, number | boolean>,
	start = 0.123,
	trim = 0.173,
): AudioClipSource {
	return {
		id: "a",
		sourceKey: "source",
		mediaAsset: {
			id: "source",
			name: "tone",
			type: "audio",
			file,
			duration: 9,
		},
		file,
		startTime: start,
		duration: 6.731,
		trimStart: trim,
		trimEnd: 0,
		volume: 1,
		muted: false,
		timelineElement: {
			id: "a",
			name: "a",
			type: "audio",
			sourceType: "upload",
			mediaId: "source",
			startTime: mediaTime({ ticks: Math.round(start * 120000) }),
			duration: mediaTime({ ticks: Math.round(6.731 * 120000) }),
			trimStart: mediaTime({ ticks: Math.round(trim * 120000) }),
			trimEnd: mediaTime({ ticks: 0 }),
			params,
		},
	};
}
/** Regression: available quota fits the real stage peak, not raw + edited +
 * mix simultaneously. Use actual OPFS files and the actual mono WAV decoder. */
export async function stagedStorageQuota() {
	const scratch = await ExportScratch.create();
	const storage = navigator.storage;
	const original = Object.getOwnPropertyDescriptor(storage, "estimate");
	const quota = 64 * 1024 ** 2 + (8 + 6.731) * 44100 * 8 + 512 * 1024;
	const usages: number[] = [];
	Object.defineProperty(storage, "estimate", {
		configurable: true,
		value: async () => {
			let usage = 0;
			for await (const entry of scratch.directory.values())
				if (entry.kind === "file") {
					const handle = await scratch.directory.getFileHandle(entry.name);
					usage += (await handle.getFile()).size;
				}
			usages.push(usage);
			return { quota, usage };
		},
	});
	try {
		const stream = await prepareExportAudio({
			tracks,
			mediaAssets: [],
			duration: 8 * 120000,
			additionalClips: [clip(wav(48000), {})],
			scratch,
			signal: new AbortController().signal,
			onProgress: () => undefined,
		});
		let frames = 0;
		for await (const buffer of stream!.buffers) frames += buffer.length;
		return { frames, usages, quota };
	} finally {
		if (original) Object.defineProperty(storage, "estimate", original);
		else Reflect.deleteProperty(storage, "estimate");
		await scratch.dispose();
	}
}

export async function audioParity() {
	const rows = [];
	for (const rate of [44100, 48000])
		for (const processing of [false, true]) {
			const scratch = await ExportScratch.create(),
				file = wav(rate);
			const first = clip(
				file,
				processing
					? {
							noiseReduction: 100,
							hardLimiterEnabled: true,
							hardLimiterCeilingDb: -1,
							volume: 1.5,
						}
					: {},
			);
			const second = {
				...clip(file, {}, 1.317, 0.331),
				id: "b",
				volume: 0.25,
				duration: 3.4,
			};
			const clips = [first, second];
			const context = new AudioContext({ sampleRate: 44100 });
			try {
				console.log("legacy", rate, processing);
				const old = await createTimelineAudioBuffer({
					tracks,
					mediaAssets: [],
					duration: 8 * 120000,
					additionalClips: clips,
					audioContext: context,
				});
				console.log("stream", rate, processing);
				const stream = await prepareExportAudio({
					tracks,
					mediaAssets: [],
					duration: 8 * 120000,
					additionalClips: clips,
					scratch,
					signal: new AbortController().signal,
					onProgress: (p) => console.log("audio-progress", p),
				});
				if (!old || !stream) throw new Error("Missing audio");
				let offset = 0,
					squared = 0,
					max = 0,
					peak = 0,
					maxWindow = 0,
					seam = 0;
				for await (const buffer of stream.buffers) {
					maxWindow = Math.max(maxWindow, buffer.length);
					for (let ch = 0; ch < 2; ch++) {
						const a = old.getChannelData(ch),
							b = buffer.getChannelData(ch);
						for (let i = 0; i < b.length; i++) {
							const e = Math.abs(a[offset + i] - b[i]);
							max = Math.max(max, e);
							squared += e * e;
							peak = Math.max(peak, Math.abs(b[i]));
							if (i < 256 || i > b.length - 256) seam = Math.max(seam, e);
						}
					}
					offset += buffer.length;
				}
				rows.push({
					rate,
					processing,
					length: offset,
					expected: old.length,
					rms: Math.sqrt(squared / (offset * 2)),
					max,
					peak,
					maxWindow,
					seam,
				});
			} finally {
				await context.close();
				await scratch.dispose();
			}
		}
	return rows;
}
export async function diskAndVideo() {
	const scratch = await ExportScratch.create(),
		signal = new AbortController().signal;
	try {
		const handle = await scratch.file("scene.mp4"),
			disk = await DiskExportTarget.open(handle, signal);
		const exporter = new SceneExporter({
			width: 320,
			height: 180,
			fps: { numerator: 25, denominator: 1 },
			format: "mp4",
			quality: "low",
			target: disk.target,
			shouldIncludeAudio: true,
			audioStream: {
				sampleRate: 44100,
				numberOfChannels: 2,
				buffers: (async function* () {
					for (let j = 0; j < 2; j++) {
						const b = new AudioBuffer({
							length: 88200,
							sampleRate: 44100,
							numberOfChannels: 2,
						});
						for (let i = 0; i < b.length; i++)
							b.getChannelData(0)[i] =
								0.1 * Math.sin((i * 2 * Math.PI * 440) / 44100);
						yield b;
					}
				})(),
			},
			signal,
		});
		const progress: number[] = [];
		exporter.on("progress", (p) => progress.push(p));
		if (
			!(await exporter.export({
				rootNode: new RootNode({ duration: 480000 }),
			}))
		)
			throw new Error("Export failed");
		await disk.commit();
		const file = await handle.getFile(),
			input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("Missing video");
		const info = {
			duration: await track.computeDuration(),
			...(await track.computePacketStats()),
			size: file.size,
			audioTracks: (await input.getAudioTracks()).length,
			progress,
		};
		const decodedFrame = await new VideoSampleSink(track).getSample(2.5);
		if (!decodedFrame || decodedFrame.displayWidth !== 320)
			throw new Error("Video is not decodable");
		decodedFrame.close();
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) throw new Error("Audio missing");
		const decodedAudio = await new AudioBufferSink(audioTrack).getBuffer(2.5);
		if (
			!decodedAudio ||
			!decodedAudio.buffer.getChannelData(0).some((x) => Math.abs(x) > 0.05)
		)
			throw new Error("Audio after chunk boundary is missing");
		input.dispose();
		const preserved = await scratch.file("cancelled.mp4");
		const original = await preserved.createWritable();
		await original.write("keep existing destination");
		await original.close();
		const aborter = new AbortController(),
			cancelledDisk = await DiskExportTarget.open(preserved, aborter.signal);
		const cancelledExport = new SceneExporter({
			width: 160,
			height: 90,
			fps: { numerator: 25, denominator: 1 },
			format: "webm",
			quality: "low",
			target: cancelledDisk.target,
			signal: aborter.signal,
		});
		cancelledExport.on("progress", () => aborter.abort());
		const cancelled = await cancelledExport.export({
			rootNode: new RootNode({ duration: 2 * 120000 }),
		});
		await cancelledDisk.abort();
		if (
			cancelled !== null ||
			(await (await preserved.getFile()).text()) !== "keep existing destination"
		)
			throw new Error("Cancellation committed a partial file");
		const pcm = new PcmFile(await scratch.file("ten-hours.pcm"), 44100, 2);
		await pcm.open();
		const context = new OfflineAudioContext(2, 1, 44100),
			tail = context.createBuffer(2, 5, 44100);
		tail.getChannelData(0).set([0.1, 0.2, 0.3, 0.4, 0.5]);
		const end = 10 * 3600 * 44100;
		await pcm.write(tail, end - 5);
		await pcm.seal();
		const last = await pcm.read(context, end - 7, 7);
		const sparse = {
			size: (await pcm.handle.getFile()).size,
			tail: Array.from(last.getChannelData(0)),
		};
		return { info, sparse };
	} finally {
		await scratch.dispose();
	}
}
export async function longMux() {
	const scratch = await ExportScratch.create(),
		signal = new AbortController().signal;
	try {
		const handle = await scratch.file("ten-hours.mp4"),
			disk = await DiskExportTarget.open(handle, signal);
		const output = new Output({
			target: disk.target,
			format: new Mp4OutputFormat({
				fastStart: "fragmented",
				minimumFragmentDuration: 2,
			}),
		});
		let packet: EncodedPacket | undefined,
			metadata: Parameters<
				NonNullable<VideoEncodingConfig["onEncodedPacket"]>
			>[1];
		// Encode one real frame, then exercise ten hours of timestamps and disk muxing.
		const memory: Uint8Array[] = [];
		const { StreamTarget } = await import("mediabunny");
		const seed = new Output({
			target: new StreamTarget(
				new WritableStream({
					write: (c) => {
						memory.push(c.data);
					},
				}),
			),
			format: new Mp4OutputFormat({ fastStart: "fragmented" }),
		});
		const encoder = new VideoSampleSource({
			codec: "avc",
			bitrate: 100000,
			onEncodedPacket: (p, m) => {
				packet = p;
				metadata = m;
			},
		});
		seed.addVideoTrack(encoder, { frameRate: 1 });
		await seed.start();
		const canvas = new OffscreenCanvas(64, 64);
		canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
		const frame = new VideoSample(canvas, { timestamp: 0, duration: 1 });
		await encoder.add(frame);
		frame.close();
		encoder.close();
		await seed.finalize();
		if (!packet) throw new Error("No encoded seed");
		const source = new EncodedVideoPacketSource("avc");
		output.addVideoTrack(source, { frameRate: 1 });
		await output.start();
		const started = performance.now();
		for (let i = 0; i < 36000; i++)
			await source.add(packet.clone({ timestamp: i, duration: 1 }), metadata);
		source.close();
		await output.finalize();
		await disk.commit();
		const file = await handle.getFile(),
			input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) }),
			track = await input.getPrimaryVideoTrack();
		const result = {
			duration: await track!.computeDuration(),
			size: file.size,
			elapsedMs: performance.now() - started,
			packets: (await track!.computePacketStats()).packetCount,
		};
		input.dispose();
		return result;
	} finally {
		await scratch.dispose();
	}
}
export async function pitchParity() {
	const { renderRetimedBuffer } = await import("@/retime");
	const { streamPitchPreserved } = await import("../pitch-stream");
	const ctx = new OfflineAudioContext(2, 1, 44100),
		source = ctx.createBuffer(2, 44100 * 32, 44100);
	for (let c = 0; c < 2; c++)
		for (let i = 0; i < source.length; i++)
			source.getChannelData(c)[i] =
				0.3 * Math.sin((i * 2 * Math.PI * 440) / 44100);
	const rows = [];
	for (const rate of [0.75, 1.5, 5]) {
		const old = await renderRetimedBuffer({
			audioContext: ctx,
			sourceBuffer: source,
			trimStart: 0.123,
			clipDuration: 6,
			retime: { rate, maintainPitch: true },
			maintainPitch: true,
		});
		const chunks = [];
		for await (const b of streamPitchPreserved({
			context: ctx,
			trimStart: 0.123,
			duration: 6,
			rate,
			readSource: async (start, end) => {
				const first = Math.floor(start * 44100),
					b = ctx.createBuffer(2, Math.ceil((end - start) * 44100) + 1, 44100);
				for (let c = 0; c < 2; c++)
					b.copyToChannel(
						source.getChannelData(c).subarray(first, first + b.length),
						c,
					);
				return { buffer: b, trimStart: start - first / 44100 };
			},
			signal: new AbortController().signal,
		}))
			chunks.push(b);
		const result = new Float32Array(old.length);
		let offset = 0;
		for (const b of chunks) {
			result.set(b.getChannelData(0), offset);
			offset += b.length;
		}
		const original = old.getChannelData(0);
		let error = 0;
		for (let i = 0; i < result.length; i++)
			error = Math.max(error, Math.abs(result[i] - original[i]));
		rows.push({
			rate,
			error,
			oldFirst: original.findIndex((x) => Math.abs(x) > 0.001),
			newFirst: result.findIndex((x) => Math.abs(x) > 0.001),
			oldTail: original.findLastIndex((x) => Math.abs(x) > 0.001),
			newTail: result.findLastIndex((x) => Math.abs(x) > 0.001),
		});
	}
	return rows;
}
/** Isolate queue/encoder snapshot correctness from the separate GPU compositor
 * integration. This fixture substitutes only the producer with a native canvas. */
export async function cutSnapshots() {
	const { CanvasRenderer } =
		await import("@/services/renderer/canvas-renderer");
	const render = CanvasRenderer.prototype.renderAndConsume;
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 180;
	const ctx = canvas.getContext("2d")!;
	CanvasRenderer.prototype.renderAndConsume = async function ({
		time,
		consume,
	}) {
		ctx.fillStyle = time < 240000 ? "red" : "blue";
		ctx.fillRect(0, 0, 320, 180);
		return consume(canvas);
	};
	const scratch = await ExportScratch.create();
	try {
		const handle = await scratch.file("cuts.mp4"),
			disk = await DiskExportTarget.open(handle, new AbortController().signal);
		const exporter = new SceneExporter({
			width: 320,
			height: 180,
			fps: { numerator: 25, denominator: 1 },
			format: "mp4",
			quality: "low",
			target: disk.target,
		});
		await exporter.export({ rootNode: new RootNode({ duration: 480000 }) });
		await disk.commit();
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(await handle.getFile()),
		});
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error("No video");
			const sink = new VideoSampleSink(track);
			const colors = [];
			for (const time of [1.96, 2.0, 2.04, 3.5]) {
				const sample = await sink.getSample(time);
				if (!sample) throw new Error("No frame");
				sample.draw(ctx, 0, 0);
				sample.close();
				colors.push(Array.from(ctx.getImageData(160, 90, 1, 1).data));
			}
			return colors;
		} finally {
			input.dispose();
		}
	} finally {
		CanvasRenderer.prototype.renderAndConsume = render;
		await scratch.dispose();
	}
}
