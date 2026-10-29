/* eslint-disable opencut/prefer-object-params, @typescript-eslint/no-unsafe-type-assertion -- Compact synthetic clip fixture; timing numbers are explicit ticks. */
import { prepareExportAudio } from "@/export/audio-stream";
import { MemoryAudioScratch } from "@/export/audio-scratch";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { RootNode } from "@/services/renderer/nodes/root-node";
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	VideoSampleSink,
} from "mediabunny";
import type { SceneTracks, ProceduralAudioElement } from "@/timeline";
import { fixtureChannels, synthesized } from "./export-pcm-source-fixture";

const ticks = (seconds: number) => Math.round(seconds * 120000);
function element(
	id: string,
	seed: number,
	start: number,
	trim: number,
	duration: number,
	rate = 1,
	volume = 0.6,
): ProceduralAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "procedural",
		name: id,
		procedural: {
			version: 1,
			engine: "earshot",
			bankRevision: "591fa3e028032e6dce56620a20e932e35667e8d8",
			presetId: "ui_pop/soft",
			seed,
			duration: 8,
		},
		startTime: ticks(start),
		duration: ticks(duration),
		trimStart: ticks(trim),
		trimEnd: ticks(8 - trim - duration * rate),
		sourceDuration: ticks(8),
		retime: { rate, maintainPitch: false },
		params: { volume: 20 * Math.log10(volume) },
	} as ProceduralAudioElement;
}
const elements = [
	element("split-first", 31, 0.123, 0.173, 2.6),
	element("split-second", 31, 2.723, 2.773, 1.4),
	element("retimed-overlap", 71, 1.3, 1.1, 2.2, 1.5, 0.3),
];
const tracks = (clips: ProceduralAudioElement[]): SceneTracks => ({
	main: {
		id: "video",
		name: "Video",
		type: "video",
		hidden: false,
		muted: false,
		elements: [],
	},
	overlay: [],
	audio: [
		{
			id: "audio",
			name: "Code sounds",
			type: "audio",
			muted: false,
			elements: clips,
		},
	],
});

export async function exportPcmParity() {
	const scene = tracks(elements),
		before = JSON.stringify(scene);
	const reference = new OfflineAudioContext(2, 6 * 44100, 44100);
	for (const clip of elements) {
		const channels = fixtureChannels(clip.procedural),
			buffer = reference.createBuffer(2, channels[0].length, 48000);
		channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
		const node = reference.createBufferSource(),
			gain = reference.createGain();
		node.buffer = buffer;
		node.playbackRate.value = clip.retime!.rate;
		gain.gain.value = 10 ** (Number(clip.params.volume) / 20);
		node.connect(gain);
		gain.connect(reference.destination);
		node.start(clip.startTime / 120000, clip.trimStart / 120000);
		node.stop((clip.startTime + clip.duration) / 120000);
	}
	const expected = await reference.startRendering();
	const scratch = new MemoryAudioScratch(),
		created: string[] = [],
		removed: string[] = [];
	const file = scratch.file.bind(scratch),
		remove = scratch.remove.bind(scratch);
	scratch.file = async (name) => {
		created.push(name);
		return file(name);
	};
	scratch.remove = async (name) => {
		removed.push(name);
		await remove(name);
	};
	try {
		const stream = await prepareExportAudio({
			tracks: scene,
			mediaAssets: [],
			duration: ticks(6),
			additionalClips: [],
			scratch,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		if (!stream) throw new Error("Code sounds were missing from export");
		let frames = 0,
			squared = 0,
			seamSquared = 0,
			seamFrames = 0,
			peak = 0;
		const output = [
			new Float32Array(expected.length),
			new Float32Array(expected.length),
		];
		for await (const buffer of stream.buffers) {
			for (let ch = 0; ch < 2; ch++) {
				output[ch].set(buffer.getChannelData(ch), frames);
				for (let i = 0; i < buffer.length; i++) {
					const value = buffer.getChannelData(ch)[i],
						error = value - expected.getChannelData(ch)[frames + i];
					squared += error * error;
					peak = Math.max(peak, Math.abs(value));
					if (Math.abs((frames + i) / 44100 - 2.723) < 0.02) {
						seamSquared += error * error;
						seamFrames++;
					}
				}
			}
			frames += buffer.length;
		}
		return {
			frames,
			rms: Math.sqrt(squared / (frames * 2)),
			seamRms: Math.sqrt(seamSquared / seamFrames),
			peak,
			silenceHead: Math.max(...output[0].subarray(0, 4000).map(Math.abs)),
			silenceTail: Math.max(...output[0].subarray(5 * 44100).map(Math.abs)),
			synthesized: [...synthesized],
			created,
			removed,
			unchanged: before === JSON.stringify(scene),
		};
	} finally {
		await scratch.dispose();
	}
}

export async function failedCodeExport() {
	const bad = element("invalid", 99, 0, 0, 1);
	bad.procedural.sourceCode = "invalid";
	const scratch = new MemoryAudioScratch();
	try {
		await prepareExportAudio({
			tracks: tracks([bad]),
			mediaAssets: [],
			duration: ticks(1),
			additionalClips: [],
			scratch,
			signal: new AbortController().signal,
			onProgress: () => {},
		});
		return "unexpected success";
	} catch (error) {
		return String(error);
	} finally {
		await scratch.dispose();
	}
}

/** The production MP4 exporter consumes the exact staged code-audio stream.
 * A tiny empty picture avoids media fixtures while testing both encoded tracks. */
export async function exportMp4RoundTrip(singleBuffer = false) {
	const scene = tracks([element("mp4-code", 31, 0.1, 1, 2.6)]);
	const scratch = new MemoryAudioScratch(),
		signal = new AbortController().signal;
	let input: Input | undefined;
	try {
		const audioStream = await prepareExportAudio({
			tracks: scene,
			mediaAssets: [],
			duration: ticks(3),
			additionalClips: [],
			scratch,
			signal,
			onProgress: () => {},
		});
		if (!audioStream) throw new Error("Code audio stream is missing");
		// The existing single-buffer export supplies a control for codec delay and
		// frame padding, independently of the production streaming adapter.
		let audioBuffer: AudioBuffer | undefined;
		if (singleBuffer) {
			audioBuffer = new AudioBuffer({
				length: 3 * 44100,
				sampleRate: 44100,
				numberOfChannels: 2,
			});
			let offset = 0;
			for await (const chunk of audioStream.buffers) {
				for (let channel = 0; channel < 2; channel++)
					audioBuffer.copyToChannel(
						chunk.getChannelData(channel),
						channel,
						offset,
					);
				offset += chunk.length;
			}
		}
		const exporter = new SceneExporter({
			width: 160,
			height: 90,
			fps: { numerator: 25, denominator: 1 },
			format: "mp4",
			quality: "low",
			shouldIncludeAudio: true,
			audioStream: singleBuffer ? undefined : audioStream,
			audioBuffer,
			signal,
		});
		let exportError = "";
		exporter.on("error", (error) => {
			exportError = error.message;
		});
		const bytes = await exporter.export({
			rootNode: new RootNode({ duration: ticks(3) }),
		});
		if (!(bytes instanceof ArrayBuffer))
			throw new Error(exportError || "MP4 export did not return a container");
		input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(new Blob([bytes], { type: "video/mp4" })),
		});
		const video = await input.getPrimaryVideoTrack(),
			audio = await input.getPrimaryAudioTrack();
		if (!video || !audio)
			throw new Error("MP4 must contain video and procedural audio tracks");
		const frame = await new VideoSampleSink(video).getSample(2.5);
		if (!frame) throw new Error("MP4 video is not decodable");
		const width = frame.displayWidth,
			height = frame.displayHeight;
		frame.close();
		const decoded = await new AudioBufferSink(audio).getBuffer(2.5);
		if (!decoded)
			throw new Error(
				"Encoded code audio is missing after the PCM chunk boundary",
			);
		const samples = decoded.buffer.getChannelData(0);
		let squared = 0,
			peak = 0;
		for (const value of samples) {
			squared += value * value;
			peak = Math.max(peak, Math.abs(value));
		}
		return {
			bytes: bytes.byteLength,
			audioCodec: audio.codec,
			audioPackets: await audio.computePacketStats(),
			decodedTimestamp: decoded.timestamp,
			box: new TextDecoder().decode(new Uint8Array(bytes, 4, 4)),
			videoDuration: await video.computeDuration(),
			audioDuration: await audio.computeDuration(),
			videoPackets: (await video.computePacketStats()).packetCount,
			audioTracks: (await input.getAudioTracks()).length,
			width,
			height,
			decodedChannels: decoded.buffer.numberOfChannels,
			decodedPeak: peak,
			decodedRms: Math.sqrt(squared / samples.length),
		};
	} finally {
		input?.dispose();
		await scratch.dispose();
	}
}
