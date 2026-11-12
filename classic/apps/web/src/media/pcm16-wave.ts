export interface Pcm16WaveLayout {
	channels: number;
	sampleRate: number;
	blockAlign: number;
	dataOffset: number;
	dataSize: number;
	frameCount: number;
	durationSeconds: number;
}

export function readPcm16WaveLayout({
	buffer,
	fileSize = buffer.byteLength,
}: {
	buffer: ArrayBuffer;
	fileSize?: number;
}): Pcm16WaveLayout | null {
	if (buffer.byteLength < 44) return null;
	const view = new DataView(buffer);
	if (
		readAscii({ view, offset: 0, length: 4 }) !== "RIFF" ||
		readAscii({ view, offset: 8, length: 4 }) !== "WAVE"
	) {
		return null;
	}

	let channels = 0;
	let sampleRate = 0;
	let blockAlign = 0;
	let bitsPerSample = 0;
	let audioFormat = 0;
	let dataOffset = -1;
	let dataSize = 0;
	let offset = 12;

	while (offset + 8 <= buffer.byteLength) {
		const chunkId = readAscii({ view, offset, length: 4 });
		const chunkSize = view.getUint32(offset + 4, true);
		const chunkOffset = offset + 8;
		if (
			chunkId === "fmt " &&
			chunkSize >= 16 &&
			chunkOffset + 16 <= buffer.byteLength
		) {
			audioFormat = view.getUint16(chunkOffset, true);
			channels = view.getUint16(chunkOffset + 2, true);
			sampleRate = view.getUint32(chunkOffset + 4, true);
			blockAlign = view.getUint16(chunkOffset + 12, true);
			bitsPerSample = view.getUint16(chunkOffset + 14, true);
		}
		if (chunkId === "data") {
			dataOffset = chunkOffset;
			dataSize = Math.min(chunkSize, fileSize - chunkOffset);
			break;
		}
		offset = chunkOffset + chunkSize + (chunkSize % 2);
	}

	if (
		audioFormat !== 1 ||
		bitsPerSample !== 16 ||
		channels < 1 ||
		sampleRate < 1 ||
		blockAlign < channels * 2 ||
		dataOffset < 0 ||
		dataSize <= 0
	) {
		return null;
	}

	const frameCount = Math.floor(dataSize / blockAlign);
	return {
		channels,
		sampleRate,
		blockAlign,
		dataOffset,
		dataSize,
		frameCount,
		durationSeconds: frameCount / sampleRate,
	};
}

function readAscii({
	view,
	offset,
	length,
}: {
	view: DataView;
	offset: number;
	length: number;
}): string {
	return Array.from({ length }, (_, index) =>
		String.fromCharCode(view.getUint8(offset + index)),
	).join("");
}
