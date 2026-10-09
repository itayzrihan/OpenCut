/* Host media I/O only: this disposable preview cache never edits a document. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";

export function mediaBinary(name: "ffmpeg" | "ffprobe"): string {
	return (
		[`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ??
		name
	);
}

export function runMediaProcess({
	command,
	args,
	signal,
}: {
	command: string;
	args: string[];
	signal?: AbortSignal;
}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		const stop = () => child.kill("SIGTERM");
		process.once("exit", stop);
		child.stdout.on("data", (data) => {
			output += String(data);
			if (output.length > 32 * 1024 * 1024) child.kill("SIGTERM");
		});
		child.stderr.on("data", (data) => {
			error = (error + String(data)).slice(-4096);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			process.removeListener("exit", stop);
			if (code === 0) resolve(output);
			else reject(new Error(`Media process failed (${code}): ${error}`));
		});
	});
}

export type VideoProbe = {
	streams: Array<{
		width: number;
		height: number;
		codec_name: string;
		pix_fmt: string;
		avg_frame_rate: string;
		color_transfer?: string;
		sample_aspect_ratio?: string;
	}>;
	packets: Array<{ pts_time?: string; duration_time?: string }>;
};

export async function probeVideo({
	path,
	signal,
}: {
	path: string;
	signal?: AbortSignal;
}): Promise<VideoProbe> {
	return JSON.parse(
		await runMediaProcess({
			command: mediaBinary("ffprobe"),
			args: [
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height,codec_name,pix_fmt,avg_frame_rate,color_transfer,sample_aspect_ratio:packet=pts_time,duration_time",
				"-of",
				"json",
				path,
			],
			signal: signal,
		}),
	);
}

/** Compare every presentation interval, including B-frame reordering and VFR.
 * A proxy that changes timing is rejected rather than silently shifting cuts. */
export function verifyProxyTiming({
	source,
	proxy,
}: {
	source: VideoProbe;
	proxy: VideoProbe;
}): void {
	const intervals = (probe: VideoProbe) =>
		probe.packets
			.map((packet) => ({
				start: Number(packet.pts_time),
				duration: Number(packet.duration_time),
			}))
			.sort((a, b) => a.start - b.start);
	const original = intervals(source),
		derived = intervals(proxy);
	if (!original.length || original.length !== derived.length)
		throw new Error("Proxy frame count differs from source");
	for (let index = 0; index < original.length; index++) {
		const a = original[index],
			b = derived[index];
		if (
			![a.start, a.duration, b.start, b.duration].every(Number.isFinite) ||
			a.duration <= 0 ||
			b.duration <= 0 ||
			Math.abs(a.start - b.start) > 0.00002 ||
			Math.abs(a.duration - b.duration) > 0.00002
		)
			throw new Error(`Proxy timing differs at frame ${index}`);
	}
}

export async function transcodePreview({
	source,
	destination,
	signal,
}: {
	source: string;
	destination: string;
	signal?: AbortSignal;
}): Promise<{ frames: number; width: number; height: number }> {
	const temporary = `${destination}.partial.mp4`;
	try {
		const original = await probeVideo({ path: source, signal: signal });
		if (!original.streams.length) throw new Error("No video track");
		const track = original.streams[0];
		if (
			["smpte2084", "arib-std-b67"].includes(track.color_transfer ?? "") ||
			(track.sample_aspect_ratio &&
				!["1:1", "N/A"].includes(track.sample_aspect_ratio))
		)
			throw new Error(
				"This source needs a color/aspect-aware proxy; using original",
			);
		await runMediaProcess({
			command: mediaBinary("ffmpeg"),
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-y",
				"-threads",
				"4",
				"-copyts",
				"-i",
				source,
				"-map",
				"0:v:0",
				"-an",
				"-sn",
				"-dn",
				"-vf",
				"scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"20",
				"-pix_fmt",
				"yuv420p",
				"-threads",
				"2",
				"-g",
				"25",
				"-bf",
				"0",
				"-fps_mode",
				"passthrough",
				"-video_track_timescale",
				"120000",
				"-movflags",
				"+faststart",
				"-fs",
				"2147483648",
				temporary,
			],
			signal: signal,
		});
		const proxy = await probeVideo({ path: temporary, signal: signal });
		verifyProxyTiming({ source: original, proxy: proxy });
		if (
			proxy.streams[0]?.codec_name !== "h264" ||
			proxy.streams[0]?.pix_fmt !== "yuv420p"
		)
			throw new Error("Unsupported proxy output");
		signal?.throwIfAborted();
		await rename(temporary, destination);
		return {
			frames: proxy.packets.length,
			width: proxy.streams[0].width,
			height: proxy.streams[0].height,
		};
	} finally {
		await rm(temporary, { force: true });
	}
}
