import { buildWords, segmentStart, segmentEnd, roundSeconds } from "./whisper-json";
import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { runProcess } from "./run-process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const runtime = "nodejs";

interface PcmAudio {
	samples: Float32Array;
	sampleRate: number;
}

const DEFAULT_BINARY_PATHS = ["whisper-cli"];

function compactStringArray(values: Array<string | null | undefined>) {
	return values.filter((value): value is string => !!value);
}

const DEFAULT_FFMPEG_PATHS = compactStringArray([
	webEnv.WHISPER_CPP_FFMPEG_PATH,
	"ffmpeg",
]);

const whisperJsonSchema = z.object({
	transcription: z
		.array(
			z.object({
				text: z.string().optional(),
				timestamps: z
					.object({
						from: z.string().optional(),
						to: z.string().optional(),
					})
					.optional(),
				offsets: z
					.object({
						from: z.number().optional(),
						to: z.number().optional(),
					})
					.optional(),
				tokens: z
					.array(
						z.object({
							text: z.string().optional(),
							t_dtw: z.number().optional(),
							timestamps: z
								.object({
									from: z.string().optional(),
									to: z.string().optional(),
								})
								.optional(),
							offsets: z
								.object({
									from: z.number().optional(),
									to: z.number().optional(),
								})
								.optional(),
						}),
					)
					.optional(),
			}),
		)
		.optional(),
});

function firstExisting(paths: string[]) {
	for (const path of paths) {
		if (path === "ffmpeg" || path === "whisper-cli" || existsSync(path)) {
			return path;
		}
	}
	return null;
}

function dtwPresetForModel(modelPath: string) {
	const normalized = modelPath.toLowerCase().replace(/\\/g, "/");
	if (normalized.includes("large-v3") || normalized.includes("large.v3")) return "large.v3";
	if (normalized.includes("large-v2") || normalized.includes("large.v2")) return "large.v2";
	if (normalized.includes("large")) return "large";
	if (normalized.includes("medium")) return "medium";
	if (normalized.includes("small")) return "small";
	if (normalized.includes("base")) return "base";
	if (normalized.includes("tiny")) return "tiny";
	return null;
}

function readUInt32LE({ buffer, offset }: { buffer: Buffer; offset: number }) {
	if (offset + 4 > buffer.length) return 0;
	return buffer.readUInt32LE(offset);
}

function readUInt16LE({ buffer, offset }: { buffer: Buffer; offset: number }) {
	if (offset + 2 > buffer.length) return 0;
	return buffer.readUInt16LE(offset);
}

function parsePcm16Wav(buffer: Buffer): PcmAudio | null {
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		return null;
	}

	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let audioFormat = 0;
	let dataStart = -1;
	let dataSize = 0;

	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString("ascii", offset, offset + 4);
		const chunkSize = readUInt32LE({ buffer, offset: offset + 4 });
		const chunkStart = offset + 8;

		if (chunkId === "fmt ") {
			audioFormat = readUInt16LE({ buffer, offset: chunkStart });
			channels = readUInt16LE({ buffer, offset: chunkStart + 2 });
			sampleRate = readUInt32LE({ buffer, offset: chunkStart + 4 });
			bitsPerSample = readUInt16LE({ buffer, offset: chunkStart + 14 });
		}

		if (chunkId === "data") {
			dataStart = chunkStart;
			dataSize = Math.min(chunkSize, buffer.length - chunkStart);
			break;
		}

		offset = chunkStart + chunkSize + (chunkSize % 2);
	}

	if (
		audioFormat !== 1 ||
		channels < 1 ||
		sampleRate <= 0 ||
		bitsPerSample !== 16 ||
		dataStart < 0 ||
		dataSize <= 0
	) {
		return null;
	}

	const frameCount = Math.floor(dataSize / (channels * 2));
	const samples = new Float32Array(frameCount);
	for (let frame = 0; frame < frameCount; frame += 1) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel += 1) {
			const sampleOffset = dataStart + (frame * channels + channel) * 2;
			sum += buffer.readInt16LE(sampleOffset) / 32768;
		}
		samples[frame] = sum / channels;
	}

	return { samples, sampleRate };
}

function rmsForRange({
	audio,
	from,
	to,
}: {
	audio: PcmAudio;
	from: number;
	to: number;
}) {
	const start = Math.max(0, Math.floor(from * audio.sampleRate));
	const end = Math.min(audio.samples.length, Math.ceil(to * audio.sampleRate));
	if (end <= start) return 0;

	let sum = 0;
	for (let index = start; index < end; index += 1) {
		const sample = audio.samples[index];
		sum += sample * sample;
	}
	return Math.sqrt(sum / (end - start));
}

function findEnergyOnset({
	audio,
	word,
}: {
	audio: PcmAudio;
	word: { start: number; end: number };
}) {
	const frameSeconds = 0.01;
	const baseline = rmsForRange({
		audio,
		from: word.start - 0.5,
		to: word.start - 0.12,
	});
	const predicted = rmsForRange({
		audio,
		from: word.start,
		to: word.start + frameSeconds,
	});
	const floor = Math.max(0.006, baseline * 2.5);

	if (predicted >= floor) {
		return word.start;
	}

	const searchEnd = Math.min(word.end - 0.02, word.start + 0.25);
	for (let time = word.start + frameSeconds; time <= searchEnd; time += frameSeconds) {
		const current = rmsForRange({ audio, from: time, to: time + frameSeconds });
		const next = rmsForRange({
			audio,
			from: time + frameSeconds,
			to: time + frameSeconds * 2,
		});
		if (current >= floor && next >= floor) {
			return time;
		}
	}

	return word.start;
}

function trimWordOverlaps(words: Array<{ text: string; start: number; end: number }>) {
	return words.map((word, index) => {
		const next = words[index + 1];
		const nextStart = next ? next.start : Number.POSITIVE_INFINITY;
		const end = Math.min(word.end, nextStart);
		return {
			...word,
			start: roundSeconds(word.start),
			end: roundSeconds(Math.max(word.start + 0.001, end)),
		};
	});
}

function refineWordTimingsWithEnergy({
	words,
	audio,
}: {
	words: Array<{ text: string; start: number; end: number }>;
	audio: PcmAudio | null;
}) {
	if (!audio) return trimWordOverlaps(words);

	const refined = words.map((word, index) => {
		const previous = words[index - 1];
		const onset = findEnergyOnset({ audio, word });
		const start = Math.min(
			Math.max(word.start, onset, previous ? previous.start : 0),
			Math.max(word.start, word.end - 0.02),
		);
		return {
			...word,
			start,
			end: Math.max(word.end, start + 0.001),
		};
	});

	return trimWordOverlaps(refined);
}

export async function POST(request: NextRequest) {
	const workDir = await mkdtemp(join(tmpdir(), "opencut-whisper-"));

	try {
		const form = await request.formData();
		const audio = form.get("audio");
		const language = String(form.get("language") || "he");

		if (!(audio instanceof File)) {
			return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
		}

		const whisperPath = firstExisting([
			webEnv.WHISPER_CPP_BINARY_PATH,
			...DEFAULT_BINARY_PATHS,
		].filter((value): value is string => !!value));
		const modelPath = firstExisting([
			webEnv.WHISPER_CPP_MODEL_PATH,
		].filter((value): value is string => !!value));
		const ffmpegPath = firstExisting(DEFAULT_FFMPEG_PATHS);

		if (!whisperPath || !modelPath || !ffmpegPath) {
			return NextResponse.json(
				{ error: "Missing whisper.cpp binary, model, or ffmpeg" },
				{ status: 503 },
			);
		}

		const inputPath = join(workDir, "input.webm");
		const wavPath = join(workDir, "audio16k.wav");
		const outBase = join(workDir, "transcript");
		const outJson = `${outBase}.json`;
		const dtwPreset = dtwPresetForModel(modelPath);
		const dtwArgs = dtwPreset ? ["-dtw", dtwPreset, "-nfa"] : [];

		await writeFile(inputPath, Buffer.from(await audio.arrayBuffer()));
		await runProcess({
			command: ffmpegPath,
			args: ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
			cwd: workDir,
			signal: request.signal,
		});

		await runProcess({
			command: whisperPath,
			args: [
				"-m",
				modelPath,
				"-f",
				wavPath,
				"-l",
				language || "he",
				"-ojf",
				"-of",
				outBase,
				"-np",
				...dtwArgs,
				...(webEnv.WHISPER_CPP_DEVICE === "cpu" ? ["-ng"] : []),
			],
			cwd: workDir,
			signal: request.signal,
		});

		const raw = whisperJsonSchema.parse(JSON.parse(await readFile(outJson, "utf8")));
		const segments = (raw.transcription || [])
			.map((segment) => ({
				text: (segment.text || "").trim(),
				start: segmentStart(segment),
				end: segmentEnd(segment),
			}))
			.filter((segment) => segment.text && segment.end > segment.start);
		const pcmAudio = parsePcm16Wav(await readFile(wavPath));
		const words = refineWordTimingsWithEnergy({
			words: buildWords({ segments: raw.transcription || [] }),
			audio: pcmAudio,
		});

		return NextResponse.json({
			text: segments.map((segment) => segment.text).join(" "),
			segments,
			words,
			language,
			source: "whisper.cpp",
			model: modelPath,
		});
	} catch (error) {
		console.error("whisper.cpp transcription failed:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error ? error.message : "Transcription failed",
			},
			{ status: 500 },
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

/** Read-only recipe preflight, without exposing local paths. */
export async function GET() {
	const configured = webEnv.WHISPER_CPP_MODEL_PATH;
	const ivritLargeV3 = !!configured && /ivrit/i.test(configured)
		&& /large[.-]v3/i.test(configured) && existsSync(configured);
	const available = ivritLargeV3
		&& !!firstExisting([webEnv.WHISPER_CPP_BINARY_PATH, ...DEFAULT_BINARY_PATHS]
			.filter((value): value is string => !!value))
		&& !!firstExisting(DEFAULT_FFMPEG_PATHS);
	return NextResponse.json({ ivritLargeV3: available }, { status: available ? 200 : 503 });
}
