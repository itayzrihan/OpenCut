import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";
import { createMediaSource, type BrowserMediaSource } from "@/media/source";

const sourceRate = 48_000;
const modelRate = 44_100;
const stemNames = ["music", "effects", "dialogue"] as const;
type ChannelPair = [Float32Array, Float32Array];

async function readAudio({
	asset,
	start,
	frames,
	signal,
}: {
	asset: BrowserMediaSource;
	start: number;
	frames: number;
	signal: AbortSignal;
}): Promise<ChannelPair> {
	const input = new Input({
		formats: ALL_FORMATS,
		source: createMediaSource({
			...asset,
			urlOptions: { maxCacheSize: 8 * 1024 ** 2, parallelism: 1 },
		}),
	});
	const abort = () => input.dispose();
	signal.addEventListener("abort", abort, { once: true });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) throw new Error("The source has no audio track");
		const rate = track.sampleRate;
		const channels = track.numberOfChannels;
		if (rate < 8000 || rate > 192000 || channels < 1 || channels > 8)
			throw new Error("Unsupported source audio format");
		const context = new OfflineAudioContext(
			2,
			Math.ceil((frames * modelRate) / sourceRate),
			modelRate,
		);
		const decoded = context.createBuffer(
			channels,
			Math.ceil((frames * rate) / sourceRate),
			rate,
		);
		for await (const { buffer, timestamp } of new AudioBufferSink(
			track,
		).buffers(start, start + frames / sourceRate)) {
			signal.throwIfAborted();
			if (buffer.sampleRate !== rate || buffer.numberOfChannels !== channels)
				throw new Error("Source audio format changed while decoding");
			const offset = Math.round((timestamp - start) * rate);
			const first = Math.max(0, -offset);
			const last = Math.min(buffer.length, decoded.length - offset);
			if (first >= last) continue;
			for (let channel = 0; channel < channels; channel++) {
				decoded
					.getChannelData(channel)
					.set(
						buffer.getChannelData(channel).subarray(first, last),
						first + offset,
					);
			}
		}
		const node = context.createBufferSource();
		node.buffer = decoded;
		node.connect(context.destination);
		node.start();
		const pcm = await context.startRendering();
		signal.throwIfAborted();
		return [pcm.getChannelData(0).slice(), pcm.getChannelData(1).slice()];
	} finally {
		signal.removeEventListener("abort", abort);
		input.dispose();
	}
}

function infer({
	channels,
	signal,
	onProgress,
}: {
	channels: ChannelPair;
	signal: AbortSignal;
	onProgress: (fraction: number) => void;
}): Promise<ChannelPair[]> {
	signal.throwIfAborted();
	const worker = new Worker(
		new URL("./browser-dbs.worker.ts", import.meta.url),
		{ type: "module" },
	);
	return new Promise((resolve, reject) => {
		const close = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			worker.terminate();
		};
		const fail = (error: unknown) => {
			close();
			reject(error);
		};
		const abort = () => fail(signal.reason);
		const timeout = setTimeout(
			() =>
				fail(new Error("DBS-TIGER exceeded the browser processing time limit")),
			15 * 60_000,
		);
		signal.addEventListener("abort", abort, { once: true });
		worker.onerror = ({ message }) =>
			fail(new Error(message || "DBS-TIGER could not start in this browser"));
		worker.onmessage = ({
			data,
		}: MessageEvent<
			{ error: string } | { stems: ChannelPair[] } | { progress: number }
		>) => {
			if ("error" in data) {
				fail(new Error(data.error));
			} else if ("progress" in data) {
				onProgress(data.progress);
			} else {
				close();
				resolve(data.stems);
			}
		};
		try {
			worker.postMessage(
				channels,
				channels.map((channel) => channel.buffer),
			);
		} catch (error) {
			fail(error);
		}
	});
}

async function renderStem({
	channels,
	frames,
}: {
	channels: ChannelPair;
	frames: number;
}): Promise<ChannelPair> {
	const context = new OfflineAudioContext(2, frames, sourceRate);
	const buffer = context.createBuffer(2, channels[0].length, modelRate);
	for (let channel = 0; channel < 2; channel++)
		buffer.getChannelData(channel).set(channels[channel]);
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	source.start();
	const result = await context.startRendering();
	return [result.getChannelData(0), result.getChannelData(1)];
}

function wav({
	channels,
	leadingFrames,
	add,
}: {
	channels: ChannelPair;
	leadingFrames: number;
	add?: ChannelPair;
}): File {
	const frames = leadingFrames + channels[0].length;
	const size = frames * 8;
	const buffer = new ArrayBuffer(44 + size);
	const bytes = new Uint8Array(buffer);
	const header = new DataView(buffer);
	const encoder = new TextEncoder();
	bytes.set(encoder.encode("RIFF"), 0);
	header.setUint32(4, 36 + size, true);
	bytes.set(encoder.encode("WAVEfmt "), 8);
	header.setUint32(16, 16, true);
	header.setUint16(20, 3, true);
	header.setUint16(22, 2, true);
	header.setUint32(24, sourceRate, true);
	header.setUint32(28, sourceRate * 8, true);
	header.setUint16(32, 8, true);
	header.setUint16(34, 32, true);
	bytes.set(encoder.encode("data"), 36);
	header.setUint32(40, size, true);
	for (let i = 0; i < channels[0].length; i++) {
		const offset = 44 + (i + leadingFrames) * 8;
		header.setFloat32(offset, channels[0][i] + (add?.[0][i] ?? 0), true);
		header.setFloat32(offset + 4, channels[1][i] + (add?.[1][i] ?? 0), true);
	}
	return new File([buffer], "stem.wav", { type: "audio/wav" });
}

export async function separateBrowserAudio({
	asset,
	start,
	frames,
	leadingFrames,
	signal,
	onProgress,
}: {
	asset: BrowserMediaSource;
	start: number;
	frames: number;
	leadingFrames: number;
	signal: AbortSignal;
	onProgress: (fraction: number) => void;
}): Promise<FormData> {
	signal.throwIfAborted();
	const length = frames - leadingFrames;
	const channels = await readAudio({ asset, start, frames: length, signal });
	const separated = await infer({ channels, signal, onProgress });
	const pcm: ChannelPair[] = [];
	for (const stem of separated) {
		signal.throwIfAborted();
		pcm.push(await renderStem({ channels: stem, frames: length }));
	}
	signal.throwIfAborted();
	const files = new FormData();
	for (const [index, name] of stemNames.entries())
		files.set(name, wav({ channels: pcm[index], leadingFrames }));
	files.set(
		"background",
		wav({ channels: pcm[0], leadingFrames, add: pcm[1] }),
	);
	return files;
}
