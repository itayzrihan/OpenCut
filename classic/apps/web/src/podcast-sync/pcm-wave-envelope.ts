import { readIntegerPcmWaveLayout } from "@/media/pcm16-wave";

const HEADER_BYTES = 64 * 1024;
const BLOCK_BYTES = 2 * 1024 * 1024;

// Local, ordinary PCM WAV can be read as bounded byte ranges. Other media
// continue through the audio decoder, which also handles fine waveform checks.
export async function readPcmWaveEnvelope({
	file,
	startSeconds,
	durationSeconds,
	mode = "rms",
	signal,
}: {
	file: Blob;
	startSeconds: number;
	durationSeconds: number;
	mode?: "rms" | "waveform";
	signal?: AbortSignal;
}): Promise<Float32Array | null> {
	signal?.throwIfAborted();
	const header = await file.slice(0, HEADER_BYTES).arrayBuffer();
	const layout = readIntegerPcmWaveLayout({
		buffer: header,
		fileSize: file.size,
	});
	if (!layout) return null;
	const {
		channels,
		blockAlign,
		sampleRate,
		dataOffset,
		frameCount,
		bitsPerSample,
	} = layout;
	const windowsPerSecond = mode === "waveform" ? 16_000 : 100;
	const bytesPerSample = bitsPerSample / 8;
	const scale = 2 ** (bitsPerSample - 1);
	if (
		channels > 2 ||
		blockAlign !== channels * bytesPerSample ||
		sampleRate > 384_000 ||
		sampleRate % windowsPerSecond !== 0
	)
		return null;

	const framesPerWindow = sampleRate / windowsPerSecond;
	const windows = Math.round(durationSeconds * windowsPerSecond);
	const first =
		mode === "waveform"
			? Math.round(startSeconds * sampleRate)
			: Math.round(startSeconds * windowsPerSecond) * framesPerWindow;
	if (windows < 1 || windows > 3_600_000 || first < 0 || first >= frameCount)
		return null;

	const result = new Float32Array(windows);
	const windowsPerBlock = Math.max(
		1,
		Math.floor(BLOCK_BYTES / (framesPerWindow * blockAlign)),
	);
	const availableWindows = Math.min(
		windows,
		Math.ceil((frameCount - first) / framesPerWindow),
	);
	for (let index = 0; index < availableWindows; index += windowsPerBlock) {
		signal?.throwIfAborted();
		const next = Math.min(availableWindows, index + windowsPerBlock);
		const start = first + index * framesPerWindow;
		const end = Math.min(frameCount, first + next * framesPerWindow);
		const bytes = await file
			.slice(dataOffset + start * blockAlign, dataOffset + end * blockAlign)
			.arrayBuffer();
		const data = new DataView(bytes);
		const sampleAt =
			bitsPerSample === 16
				? (offset: number) => data.getInt16(offset, true)
				: (offset: number) =>
						(data.getInt8(offset + 2) << 16) |
						(data.getUint8(offset + 1) << 8) |
						data.getUint8(offset);
		let offset = 0;
		for (let window = index; window < next; window++) {
			const frames = Math.min(
				framesPerWindow,
				(data.byteLength - offset) / blockAlign,
			);
			let sum = 0;
			for (let frame = 0; frame < frames; frame++) {
				const left = sampleAt(offset);
				const mono =
					channels === 2
						? (left + sampleAt(offset + bytesPerSample)) * 0.5
						: left;
				sum += mode === "waveform" ? mono : mono * mono;
				offset += blockAlign;
			}
			result[window] =
				(mode === "waveform" ? sum / frames : Math.sqrt(sum / frames)) / scale;
		}
	}
	signal?.throwIfAborted();
	return result;
}
