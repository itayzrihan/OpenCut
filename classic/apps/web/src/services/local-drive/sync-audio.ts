import { AudioLandmarks } from "@/podcast-sync/audio-landmarks";
import { spawn } from "node:child_process";
import { extname } from "node:path";
import { requireAccount } from "@/accounts/server";
import { mediaBinary, runMediaProcess } from "@/services/video-proxy/transcode";

const SAMPLE_RATE = 16_000;
const HOP = 160;
const MAX_DURATION = 36_000;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const formats: Record<string, string> = {
	mp4: "mov",
	mov: "mov",
	m4a: "mov",
	m4v: "mov",
	mxf: "mxf",
	webm: "matroska",
	mkv: "matroska",
	avi: "avi",
	wav: "wav",
	flac: "flac",
	mp3: "mp3",
	aac: "aac",
	ogg: "ogg",
};
type Source = {
	path: string;
	stat: { size: number; mtimeMs: number; ctimeMs: number };
};
type AudioResponse = { bytes: Uint8Array<ArrayBuffer>; contentType: string };
const cache = new Map<string, AudioResponse>();
let cacheBytes = 0;
let active = 0;
const waiting = new Set<() => void>();

async function acquire(signal: AbortSignal) {
	while (active >= 4) {
		signal.throwIfAborted();
		if (waiting.size >= 32) throw new Error("Audio analysis is busy");
		await new Promise<void>((resolve, reject) => {
			const resume = () => {
				cleanup();
				resolve();
			};
			const abort = () => {
				cleanup();
				reject(signal.reason);
			};
			const cleanup = () => {
				waiting.delete(resume);
				signal.removeEventListener("abort", abort);
			};
			waiting.add(resume);
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	signal.throwIfAborted();
	active++;
	return () => {
		active--;
		waiting.values().next().value?.();
	};
}

export async function serveSyncAudio({
	request,
	source,
	params,
}: {
	request: Request;
	source: Source;
	params: URLSearchParams;
}) {
	const mode = params.get("syncAudio");
	const extension = extname(source.path).slice(1).toLowerCase();
	const format = Object.hasOwn(formats, extension)
		? formats[extension]
		: undefined;
	const start = Number(params.get("start") ?? 0);
	const length = params.has("seconds")
		? Number(params.get("seconds"))
		: undefined;
	if (
		!format ||
		!["info", "energy", "waveform", "fingerprint"].includes(mode ?? "") ||
		!Number.isFinite(start) ||
		start < 0 ||
		start >= MAX_DURATION ||
		(length == null
			? start !== 0 || mode === "waveform"
			: !Number.isFinite(length) ||
				length <= 0 ||
				length > (mode === "waveform" ? 30 : MAX_DURATION) ||
				start + length > MAX_DURATION + 0.01)
	)
		return new Response(null, {
			status: 422,
			headers: { "Cache-Control": "no-store" },
		});
	const signal = AbortSignal.any([
		request.signal,
		AbortSignal.timeout(180_000),
	]);
	const key = JSON.stringify([
		requireAccount().id,
		source.path,
		source.stat.size,
		source.stat.mtimeMs,
		source.stat.ctimeMs,
		mode,
		start,
		length,
	]);
	const cached = cache.get(key);
	if (cached) {
		cache.delete(key);
		cache.set(key, cached);
		return response(cached);
	}

	const release = await acquire(signal);
	try {
		const input = ["-protocol_whitelist", "file,pipe", "-f", format];
		let result: AudioResponse;
		if (mode === "info") {
			const metadata = JSON.parse(
				await runMediaProcess({
					command: mediaBinary("ffprobe"),
					args: [
						"-v",
						"error",
						...input,
						"-show_entries",
						"format_tags=creation_time,timecode:stream_tags=creation_time,timecode",
						"-of",
						"json",
						source.path,
					],
					signal,
				}),
			) as {
				format?: { tags?: Record<string, string> };
				streams?: Array<{ tags?: Record<string, string> }>;
			};
			const stamp =
				metadata.format?.tags?.creation_time ??
				metadata.streams?.find((stream) => stream.tags?.creation_time)?.tags
					?.creation_time;
			const captureTime =
				stamp && /^\d{4}-\d{2}-\d{2}T/.test(stamp) ? Date.parse(stamp) : NaN;
			result = {
				bytes: new TextEncoder().encode(
					JSON.stringify({
						captureTime: Number.isFinite(captureTime) ? captureTime : null,
					}),
				),
				contentType: "application/json",
			};
		} else {
			result = {
				bytes: await decodeAudio({
					source,
					input,
					start,
					length,
					waveform: mode === "waveform",
					fingerprint: mode === "fingerprint",
					signal,
				}),
				contentType: "application/octet-stream",
			};
		}
		signal.throwIfAborted();
		if (!cache.has(key) && result.bytes.byteLength <= MAX_CACHE_BYTES) {
			while (
				cache.size >= 512 ||
				cacheBytes + result.bytes.byteLength > MAX_CACHE_BYTES
			) {
				const oldest = cache.keys().next().value!;
				cacheBytes -= cache.get(oldest)!.bytes.byteLength;
				cache.delete(oldest);
			}
			cache.set(key, result);
			cacheBytes += result.bytes.byteLength;
		}
		return response(result);
	} finally {
		release();
	}
}

function response({ bytes, contentType }: AudioResponse) {
	return new Response(bytes, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": "private, no-store",
		},
	});
}

async function decodeAudio({
	source,
	input,
	start,
	length,
	waveform,
	fingerprint,
	signal,
}: {
	source: Source;
	input: string[];
	start: number;
	length?: number;
	waveform: boolean;
	fingerprint: boolean;
	signal: AbortSignal;
}) {
	const child = spawn(
		mediaBinary("ffmpeg"),
		[
			"-nostdin",
			"-v",
			"error",
			...input,
			...(start ? ["-ss", String(start)] : []),
			"-i",
			source.path,
			"-map",
			"0:a:0",
			"-vn",
			"-sn",
			"-dn",
			"-t",
			String(length ?? MAX_DURATION),
			"-ac",
			"1",
			"-ar",
			String(SAMPLE_RATE),
			"-f",
			"f32le",
			"pipe:1",
		],
		{ signal, stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
	);
	const finished = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? resolve() : reject(new Error("Audio extraction failed")),
		);
	});
	// A child can fail before the stream iteration reaches its final await.
	void finished.catch(() => {});
	const rate = waveform ? SAMPLE_RATE : 100;
	const landmarks = fingerprint ? new AudioLandmarks() : null;
	const samples = new Float32Array(
		landmarks ? 0 : Math.ceil((length ?? MAX_DURATION) * rate),
	);
	let index = 0,
		count = 0,
		sum = 0;
	let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	try {
		for await (const packet of child.stdout!) {
			signal.throwIfAborted();
			const chunk: Buffer = remainder.length
				? Buffer.concat([remainder, packet])
				: packet;
			const end = chunk.length - (chunk.length % 4);
			remainder = chunk.subarray(end);
			for (
				let pos = 0;
				pos < end && (landmarks || index < samples.length);
				pos += 4
			) {
				const value = chunk.readFloatLE(pos);
				if (landmarks) {
					landmarks.push(value);
				} else if (waveform) {
					samples[index++] = value;
				} else {
					sum += value * value;
					if (++count === HOP) {
						samples[index++] = Math.sqrt(sum / count);
						count = 0;
						sum = 0;
					}
				}
			}
		}
		await finished;
		if (landmarks) return new Uint8Array(landmarks.finish().buffer);
		if (count && index < samples.length)
			samples[index++] = Math.sqrt(sum / count);
		if (!index) throw new Error("No audio samples");
		// The cache owns these bytes. A view over an oversized decode buffer
		// would keep its entire backing allocation alive between requests.
		const finishedSamples = length == null ? samples.slice(0, index) : samples;
		return new Uint8Array(finishedSamples.buffer);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill();
	}
}
