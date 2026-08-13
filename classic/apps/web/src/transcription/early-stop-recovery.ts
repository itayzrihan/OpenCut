import type { TranscriptionResult, TranscriptionWord } from "./types";

const RECOVERY_OVERLAP_SECONDS = 0.8;
const MIN_TRAILING_AUDIO_SECONDS = 1.2;
const MIN_RECOVERY_PROGRESS_SECONDS = 0.25;
const TRAILING_AUDIO_RMS_THRESHOLD = 0.002;
const DEFAULT_MAX_RECOVERY_PASSES = 3;

interface Pcm16Wav {
	buffer: ArrayBuffer;
	channels: number;
	sampleRate: number;
	blockAlign: number;
	dataOffset: number;
	dataSize: number;
	frameCount: number;
	durationSeconds: number;
}

export async function recoverEarlyStoppedTranscription({
	audioBlob,
	initialResult,
	transcribe,
	maxRecoveryPasses = DEFAULT_MAX_RECOVERY_PASSES,
}: {
	audioBlob: Blob;
	initialResult: TranscriptionResult;
	transcribe: (options: { audioBlob: Blob }) => Promise<TranscriptionResult>;
	maxRecoveryPasses?: number;
}): Promise<TranscriptionResult> {
	const wav = await readPcm16Wav({ audioBlob });
	if (!wav) return initialResult;

	let merged = initialResult;
	for (let pass = 0; pass < maxRecoveryPasses; pass += 1) {
		const previousEnd = getTranscriptionEnd({ result: merged });
		if (
			wav.durationSeconds - previousEnd < MIN_TRAILING_AUDIO_SECONDS ||
			getPcmRms({ wav, startSeconds: previousEnd + 0.1 }) <
				TRAILING_AUDIO_RMS_THRESHOLD
		) {
			break;
		}

		const offsetSeconds = Math.max(
			0,
			previousEnd - RECOVERY_OVERLAP_SECONDS,
		);
		const recoveryBlob = slicePcm16Wav({ wav, startSeconds: offsetSeconds });
		const recovered = offsetTranscriptionResult({
			result: await transcribe({ audioBlob: recoveryBlob }),
			offsetSeconds,
		});
		merged = mergeTranscriptionResults({ base: merged, recovered });

		if (
			getTranscriptionEnd({ result: merged }) <
			previousEnd + MIN_RECOVERY_PROGRESS_SECONDS
		) {
			break;
		}
	}

	return merged;
}

function getTranscriptionEnd({
	result,
}: {
	result: TranscriptionResult;
}): number {
	return Math.max(
		0,
		...result.segments.map((segment) => segment.end),
		...(result.words ?? []).map((word) => word.end),
	);
}

async function readPcm16Wav({
	audioBlob,
}: {
	audioBlob: Blob;
}): Promise<Pcm16Wav | null> {
	const buffer = await audioBlob.arrayBuffer();
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
		if (chunkId === "fmt " && chunkOffset + 16 <= buffer.byteLength) {
			audioFormat = view.getUint16(chunkOffset, true);
			channels = view.getUint16(chunkOffset + 2, true);
			sampleRate = view.getUint32(chunkOffset + 4, true);
			blockAlign = view.getUint16(chunkOffset + 12, true);
			bitsPerSample = view.getUint16(chunkOffset + 14, true);
		}
		if (chunkId === "data") {
			dataOffset = chunkOffset;
			dataSize = Math.min(chunkSize, buffer.byteLength - chunkOffset);
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
		buffer,
		channels,
		sampleRate,
		blockAlign,
		dataOffset,
		dataSize,
		frameCount,
		durationSeconds: frameCount / sampleRate,
	};
}

function getPcmRms({
	wav,
	startSeconds,
}: {
	wav: Pcm16Wav;
	startSeconds: number;
}): number {
	const startFrame = Math.min(
		wav.frameCount,
		Math.max(0, Math.floor(startSeconds * wav.sampleRate)),
	);
	const view = new DataView(wav.buffer);
	let squareSum = 0;
	let sampleCount = 0;

	for (let frame = startFrame; frame < wav.frameCount; frame += 1) {
		for (let channel = 0; channel < wav.channels; channel += 1) {
			const offset =
				wav.dataOffset + frame * wav.blockAlign + channel * 2;
			const sample = view.getInt16(offset, true) / 32768;
			squareSum += sample * sample;
			sampleCount += 1;
		}
	}

	return sampleCount > 0 ? Math.sqrt(squareSum / sampleCount) : 0;
}

function slicePcm16Wav({
	wav,
	startSeconds,
}: {
	wav: Pcm16Wav;
	startSeconds: number;
}): Blob {
	const startFrame = Math.min(
		wav.frameCount,
		Math.max(0, Math.floor(startSeconds * wav.sampleRate)),
	);
	const sourceOffset = wav.dataOffset + startFrame * wav.blockAlign;
	const dataLength = wav.dataSize - startFrame * wav.blockAlign;
	const output = new ArrayBuffer(44 + dataLength);
	const outputView = new DataView(output);
	writeAscii({ view: outputView, offset: 0, value: "RIFF" });
	outputView.setUint32(4, 36 + dataLength, true);
	writeAscii({ view: outputView, offset: 8, value: "WAVE" });
	writeAscii({ view: outputView, offset: 12, value: "fmt " });
	outputView.setUint32(16, 16, true);
	outputView.setUint16(20, 1, true);
	outputView.setUint16(22, wav.channels, true);
	outputView.setUint32(24, wav.sampleRate, true);
	outputView.setUint32(28, wav.sampleRate * wav.blockAlign, true);
	outputView.setUint16(32, wav.blockAlign, true);
	outputView.setUint16(34, 16, true);
	writeAscii({ view: outputView, offset: 36, value: "data" });
	outputView.setUint32(40, dataLength, true);
	new Uint8Array(output, 44).set(
		new Uint8Array(wav.buffer, sourceOffset, dataLength),
	);
	return new Blob([output], { type: "audio/wav" });
}

function offsetTranscriptionResult({
	result,
	offsetSeconds,
}: {
	result: TranscriptionResult;
	offsetSeconds: number;
}): TranscriptionResult {
	return {
		...result,
		segments: result.segments.map((segment) => ({
			...segment,
			start: segment.start + offsetSeconds,
			end: segment.end + offsetSeconds,
		})),
		words: result.words?.map((word) => ({
			...word,
			start: word.start + offsetSeconds,
			end: word.end + offsetSeconds,
		})),
	};
}

function mergeTranscriptionResults({
	base,
	recovered,
}: {
	base: TranscriptionResult;
	recovered: TranscriptionResult;
}): TranscriptionResult {
	const baseWords = base.words ?? [];
	const recoveredWords = recovered.words ?? [];
	const overlapCount = findWordOverlap({ baseWords, recoveredWords });
	const baseEnd = getTranscriptionEnd({ result: base });
	const candidateWords =
		overlapCount > 0
			? recoveredWords.slice(overlapCount)
			: recoveredWords.filter((word) => word.end > baseEnd + 0.05);
	const mergedWords = appendMonotonicWords({
		baseWords,
		candidateWords,
	});
	const mergedSegments = [
		...base.segments,
		...recovered.segments.filter((segment) => segment.end > baseEnd + 0.05),
	];

	return {
		language: base.language || recovered.language,
		text:
			mergedWords.length > 0
				? mergedWords.map((word) => word.text).join(" ")
				: mergedSegments.map((segment) => segment.text).join(" "),
		segments: mergedSegments,
		words: mergedWords.length > 0 ? mergedWords : undefined,
	};
}

function findWordOverlap({
	baseWords,
	recoveredWords,
}: {
	baseWords: TranscriptionWord[];
	recoveredWords: TranscriptionWord[];
}): number {
	const maximum = Math.min(20, baseWords.length, recoveredWords.length);
	for (let length = maximum; length > 0; length -= 1) {
		const baseStart = baseWords.length - length;
		const matches = Array.from({ length }, (_, index) => index).every(
			(index) =>
				normalizeWord({ text: baseWords[baseStart + index].text }) ===
				normalizeWord({ text: recoveredWords[index].text }),
		);
		if (matches) return length;
	}
	return 0;
}

function appendMonotonicWords({
	baseWords,
	candidateWords,
}: {
	baseWords: TranscriptionWord[];
	candidateWords: TranscriptionWord[];
}): TranscriptionWord[] {
	const merged = baseWords.map((word) => ({ ...word }));
	for (const word of candidateWords) {
		const previousEnd = merged.at(-1)?.end ?? 0;
		const start = Math.max(previousEnd, word.start);
		merged.push({ ...word, start, end: Math.max(word.end, start + 0.001) });
	}
	return merged;
}

function normalizeWord({ text }: { text: string }): string {
	return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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

function writeAscii({
	view,
	offset,
	value,
}: {
	view: DataView;
	offset: number;
	value: string;
}) {
	for (let index = 0; index < value.length; index += 1) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}
