import { readPcm16WaveLayout } from "@/media/pcm16-wave";

const HEADER_BYTES = 64 * 1024;
const BLOCK_BYTES = 2 * 1024 * 1024;
const WINDOWS_PER_SECOND = 100;
const PCM16_SCALE = 32768;

// Local, ordinary PCM WAV can be read as bounded byte ranges. Other media
// continue through the audio decoder, which also handles fine waveform checks.
export async function readPcm16Envelope({
	file,
	startSeconds,
	durationSeconds,
}: {
	file: Blob;
	startSeconds: number;
	durationSeconds: number;
}): Promise<Float32Array | null> {
	const header = await file.slice(0, HEADER_BYTES).arrayBuffer();
	const layout = readPcm16WaveLayout({ buffer: header, fileSize: file.size });
	if (!layout) return null;
	const { channels, blockAlign, sampleRate, dataOffset, frameCount } = layout;
	if (
		channels > 2 ||
		blockAlign !== channels * 2 ||
		sampleRate > 384_000 ||
		sampleRate % WINDOWS_PER_SECOND !== 0
	)
		return null;

	const framesPerWindow = sampleRate / WINDOWS_PER_SECOND;
	const windows = Math.round(durationSeconds * WINDOWS_PER_SECOND);
	const first = Math.round(startSeconds * WINDOWS_PER_SECOND) * framesPerWindow;
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
		const next = Math.min(availableWindows, index + windowsPerBlock);
		const start = first + index * framesPerWindow;
		const end = Math.min(frameCount, first + next * framesPerWindow);
		const bytes = await file
			.slice(dataOffset + start * blockAlign, dataOffset + end * blockAlign)
			.arrayBuffer();
		const data = new DataView(bytes);
		let offset = 0;
		for (let window = index; window < next; window++) {
			const frames = Math.min(
				framesPerWindow,
				(data.byteLength - offset) / blockAlign,
			);
			let sum = 0;
			for (let frame = 0; frame < frames; frame++) {
				const left = data.getInt16(offset, true);
				const mono =
					channels === 2
						? (left + data.getInt16(offset + 2, true)) * 0.5
						: left;
				sum += mono * mono;
				offset += blockAlign;
			}
			result[window] = Math.sqrt(sum / frames) / PCM16_SCALE;
		}
	}
	return result;
}
