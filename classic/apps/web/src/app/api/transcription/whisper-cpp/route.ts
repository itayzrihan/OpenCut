import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const runtime = "nodejs";

interface WhisperSegment {
	text?: string;
	timestamps?: {
		from?: string;
		to?: string;
	};
	offsets?: {
		from?: number;
		to?: number;
	};
	tokens?: Array<{
		text?: string;
		t_dtw?: number;
		timestamps?: {
			from?: string;
			to?: string;
		};
		offsets?: {
			from?: number;
			to?: number;
		};
	}>;
}

interface WordTiming {
	text: string;
	start: number;
	end: number;
	dtwStart?: number;
	dtwEnd?: number;
	segmentStart?: number;
	segmentEnd?: number;
}

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

function parseTimestamp(value?: string) {
	if (!value) return 0;
	const parts = value.trim().replace(",", ".").split(":").map(Number);
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return Number(value) || 0;
}

function segmentStart(segment: WhisperSegment) {
	if (typeof segment.offsets?.from === "number") return segment.offsets.from / 1000;
	return parseTimestamp(segment.timestamps?.from);
}

function segmentEnd(segment: WhisperSegment) {
	if (typeof segment.offsets?.to === "number") return segment.offsets.to / 1000;
	return parseTimestamp(segment.timestamps?.to);
}

function tokenStart({
	token,
	fallback,
}: {
	token: NonNullable<WhisperSegment["tokens"]>[number];
	fallback: number;
}) {
	if (typeof token.offsets?.from === "number") return token.offsets.from / 1000;
	return parseTimestamp(token.timestamps?.from) || fallback;
}

function tokenEnd({
	token,
	fallback,
}: {
	token: NonNullable<WhisperSegment["tokens"]>[number];
	fallback: number;
}) {
	if (typeof token.offsets?.to === "number") return token.offsets.to / 1000;
	return parseTimestamp(token.timestamps?.to) || fallback;
}

function tokenDtwSeconds(token: NonNullable<WhisperSegment["tokens"]>[number]) {
	const value = Number(token.t_dtw);
	return Number.isFinite(value) && value >= 0 ? value / 100 : null;
}

function roundSeconds(value: number) {
	return Math.round(value * 1000) / 1000;
}

function cleanTokenText(text: string) {
	return text.replace(/\[_BEG_\]|\[_TT_\d+\]|\[_EOT_\]|\[_SOLM_\]|\[_PREV_\]|\[_NOT_\]/g, "");
}

function isPunctuationOnly(text: string) {
	return /^[\s.,!?;:()[\]{}"'`\-.]+$/.test(text);
}

function finalizeWordTimings(words: WordTiming[]) {
	if (words.length === 0) return words;

	const centers = words.map((word) => (
		typeof word.dtwStart === "number" && typeof word.dtwEnd === "number"
			? (word.dtwStart + word.dtwEnd) / 2
			: null
	));

	return words.map((word, index) => {
		const center = centers[index];
		if (center === null) {
			return {
				text: word.text,
				start: roundSeconds(Math.max(0, word.start)),
				end: roundSeconds(Math.max(word.end, word.start + 0.001)),
			};
		}

		const prevCenter = index > 0 ? centers[index - 1] : null;
		const nextCenter = index + 1 < centers.length ? centers[index + 1] : null;
		const segmentStartTime = Number.isFinite(word.segmentStart)
			? Number(word.segmentStart)
			: word.start;
		const segmentEndTime = Number.isFinite(word.segmentEnd)
			? Number(word.segmentEnd)
			: word.end;
		const midpointStart = prevCenter === null
			? segmentStartTime
			: (prevCenter + center) / 2;
		const dtwStart = typeof word.dtwStart === "number" ? word.dtwStart : word.start;
		const dtwEnd = typeof word.dtwEnd === "number" ? word.dtwEnd : word.end;

		// Start captions no earlier than the aligned token onset.
		const start = Math.max(segmentStartTime, midpointStart, dtwStart);
		const end = nextCenter === null
			? Math.min(segmentEndTime, dtwEnd + 0.12)
			: (center + nextCenter) / 2;

		return {
			text: word.text,
			start: roundSeconds(Math.max(0, start)),
			end: roundSeconds(Math.max(end, start + 0.001)),
		};
	});
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

function buildWords({ segments }: { segments: WhisperSegment[] }) {
	const words: WordTiming[] = [];

	for (const segment of segments) {
		const segmentStartTime = segmentStart(segment);
		const segmentEndTime = segmentEnd(segment);
		let current: WordTiming | null = null;

		for (const token of segment.tokens || []) {
			const raw = cleanTokenText(token.text || "");
			if (!raw.trim()) continue;

			const start = tokenStart({ token, fallback: segmentStartTime });
			const end = tokenEnd({ token, fallback: segmentEndTime });
			const dtw = tokenDtwSeconds(token);
			const hasLeadingSpace = /^\s/.test(raw);
			const piece = raw.replace(/\s+/g, " ").trim();
			if (!piece) continue;

			if (isPunctuationOnly(piece)) {
				if (current) {
					current.text += piece;
					current.end = Math.max(current.end, end);
					if (dtw !== null) {
						current.dtwEnd = dtw;
					}
				}
				continue;
			}

			if (!current || hasLeadingSpace) {
				if (current) words.push(current);
				current = {
					text: piece,
					start,
					end: Math.max(end, start + 0.001),
					dtwStart: dtw ?? undefined,
					dtwEnd: dtw ?? undefined,
					segmentStart: segmentStartTime,
					segmentEnd: segmentEndTime,
				};
				continue;
			}

			current.text += piece;
			current.end = Math.max(current.end, end);
			if (dtw !== null) {
				current.dtwEnd = dtw;
				current.dtwStart ??= dtw;
			}
		}

		if (current) {
			words.push(current);
			continue;
		}

		const fallbackWords = (segment.text || "").trim().split(/\s+/).filter(Boolean);
		if (fallbackWords.length === 0) continue;
		const duration = Math.max(0.1, segmentEndTime - segmentStartTime);
		const wordDuration = duration / fallbackWords.length;
		fallbackWords.forEach((text, index) => {
			words.push({
				text,
				start: segmentStartTime + index * wordDuration,
				end: segmentStartTime + (index + 1) * wordDuration,
			});
		});
	}

	return finalizeWordTimings(words);
}

function runProcess({
	command,
	args,
	cwd,
	timeoutMs = 30 * 60 * 1000,
}: {
	command: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
}) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd, windowsHide: true });
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(stderr.slice(-1000) || `${command} exited with ${code}`));
		});
	});
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
			],
			cwd: workDir,
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
