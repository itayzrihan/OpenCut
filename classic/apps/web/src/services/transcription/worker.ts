import {
	env,
	pipeline,
	TextStreamer,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers-v4";
import type {
	TranscriptionResult,
	TranscriptionProgress,
} from "@/transcription/types";
import {
	BROWSER_WHISPER_MODEL,
	BROWSER_WHISPER_REVISION,
	BROWSER_WHISPER_CPU_MODEL,
	BROWSER_WHISPER_CPU_REVISION,
	BROWSER_TRANSCRIPTION_LABELS,
	DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
	MULTILINGUAL_WHISPER_MODEL,
	MULTILINGUAL_WHISPER_REVISION,
	type BrowserTranscriptionModel,
} from "@/transcription/models";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";
import { boundWhisperGpuOutputs } from "./gpu-lifetime";

export type WorkerMessage = {
	audio: Float32Array;
	language: string;
	browserModel?: BrowserTranscriptionModel;
	lowMemory?: boolean;
	keepAlive?: boolean;
	recovery?: boolean;
};
export type WorkerResponse =
	| { type: "progress"; progress: TranscriptionProgress }
	| { type: "complete"; result: TranscriptionResult }
	| { type: "retry-low-memory"; audio: Float32Array }
	| { type: "error"; error: string; diagnostic?: string };

env.allowLocalModels = false;
env.useBrowserCache = true;
// Single-thread WASM also works on HTTPS deployments without COOP/COEP.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

const report = ({
	status,
	progress,
	message,
}: {
	status: TranscriptionProgress["status"];
	progress: number;
	message: string;
}) =>
	self.postMessage({
		type: "progress",
		progress: { status, progress, message },
	} satisfies WorkerResponse);

let resident: AutomaticSpeechRecognitionPipeline | undefined;

self.onmessage = async ({
	data: {
		audio,
		language,
		browserModel = DEFAULT_BROWSER_TRANSCRIPTION_MODEL,
		lowMemory = false,
		keepAlive = false,
		recovery = false,
	},
}: MessageEvent<WorkerMessage>) => {
	let transcriber: AutomaticSpeechRecognitionPipeline | undefined;
	let device: "webgpu" | "wasm" = "wasm";
	let phase = "loading-model";
	const multilingual = browserModel === "whisper-large-v3-turbo";
	const loadingFiles = new Map<string, string>();
	try {
		const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
		device = adapter?.features.has("shader-f16") ? "webgpu" : "wasm";
		const modelLabel = BROWSER_TRANSCRIPTION_LABELS[browserModel];
		const modelId = multilingual
			? MULTILINGUAL_WHISPER_MODEL
			: device === "webgpu"
				? BROWSER_WHISPER_MODEL
				: BROWSER_WHISPER_CPU_MODEL;
		const revision = multilingual
			? MULTILINGUAL_WHISPER_REVISION
			: device === "webgpu"
				? BROWSER_WHISPER_REVISION
				: BROWSER_WHISPER_CPU_REVISION;
		const requestedLanguage =
			language === "auto" ? (multilingual ? undefined : "he") : language;
		const label =
			device === "webgpu"
				? `GPU · WebGPU${!multilingual && lowMemory ? " · reduced-memory model" : ""}`
				: "CPU · WebAssembly (WebGPU fp16 unavailable; slower)";
		report({
			status: "loading-model",
			progress: 0,
			message: `Loading ${modelLabel} on your ${label}. The browser caches the model after the first download…`,
		});
		const files = new Map<string, { loaded: number; total: number }>();
		let lastReport = 0;
		transcriber =
			resident ??
			((await pipeline<"automatic-speech-recognition">(
				"automatic-speech-recognition",
				modelId,
				{
					revision,
					device,
					dtype:
						device === "wasm"
							? "q8"
							: multilingual
								? "q4f16"
								: {
										encoder_model: lowMemory ? "q4" : "fp16",
										decoder_model_merged: "q4",
									},
					progress_callback: (info) => {
						if (info.status === "download" || info.status === "done")
							loadingFiles.set(info.file, info.status);
						if (info.status !== "progress") return;
						files.set(info.file, { loaded: info.loaded, total: info.total });
						if (Date.now() - lastReport < 250) return;
						lastReport = Date.now();
						let loaded = 0,
							total = 0;
						for (const value of files.values()) {
							loaded += value.loaded;
							total += value.total;
						}
						report({
							status: "loading-model",
							progress: total ? (100 * loaded) / total : 0,
							message: `Loading ${modelLabel} on your ${label} · ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB · downloaded weights are cached in this browser`,
						});
					},
				},
			)) as AutomaticSpeechRecognitionPipeline);
		if (!resident && device === "webgpu")
			boundWhisperGpuOutputs(transcriber.model);
		if (keepAlive) resident = transcriber;
		phase = "transcribing";
		report({
			status: "transcribing",
			progress: 0,
			message: `Transcribing on your ${label}…`,
		});
		let tokens = 0;
		const started = Date.now();
		const streamer = new TextStreamer(transcriber.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: () => {
				tokens++;
				if (Date.now() - lastReport < 500) return;
				lastReport = Date.now();
				report({
					status: "transcribing",
					progress: 0,
					message: `Transcribing on your ${label} · ${Math.round((Date.now() - started) / 1000)}s · ${tokens} text fragments`,
				});
			},
		});
		const output = await transcriber(audio, {
			chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
			stride_length_s: DEFAULT_STRIDE_SECONDS,
			language: requestedLanguage,
			task: "transcribe",
			return_timestamps: "word",
			streamer,
		});
		const result: AutomaticSpeechRecognitionOutput = Array.isArray(output)
			? output[0]
			: output;
		const duration = audio.length / 16000;
		const words = (result.chunks ?? []).flatMap(
			({ text, timestamp: [start, end] }) => {
				if (start === null || !Number.isFinite(start) || !text.trim())
					return [];
				const boundedStart = Math.max(0, Math.min(duration, start));
				return [
					{
						text: text.trim(),
						start: boundedStart,
						end: Math.max(
							boundedStart,
							Math.min(
								duration,
								end !== null && Number.isFinite(end) ? end : duration,
							),
						),
					},
				];
			},
		);
		const unaligned =
			words.length > 0 && words.every((word) => word.end <= word.start);
		if (!recovery && result.text.trim() && !words.length)
			throw new Error(
				"The browser model did not return timed words. Captions were not changed.",
			);
		if (!recovery && unaligned)
			throw new Error(
				"The browser model could not align the words to the audio. Captions were not changed.",
			);
		// A short recovery pass can yield text with no usable timing. Keep the
		// successful primary transcript and merge only timed recovery words.
		const timedWords = unaligned ? [] : words;
		self.postMessage({
			type: "complete",
			result: {
				text: recovery && !timedWords.length ? "" : result.text,
				words: timedWords,
				segments: timedWords,
				language: requestedLanguage ?? "auto",
			},
		} satisfies WorkerResponse);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const memoryFailure =
			/array\s*buffer allocation failed|out of memory|memory access out of bounds|failed to allocate|cannot allocate|allocation failed/i.test(
				detail,
			);
		if (memoryFailure && device === "webgpu" && !multilingual && !lowMemory) {
			// Transfer ownership back, then let the service terminate this worker.
			// A failed pipeline load may retain sessions we cannot dispose directly.
			// Never load the fallback alongside those sessions or clone the audio.
			self.postMessage(
				{ type: "retry-low-memory", audio } satisfies WorkerResponse,
				{ transfer: [audio.buffer] },
			);
			return;
		}
		self.postMessage({
			type: "error",
			diagnostic: `${phase}; ${device}; lowMemory=${lowMemory}; audioSeconds=${audio.length / 16000}; files=${JSON.stringify([...loadingFiles])}\n${error instanceof Error ? error.stack : String(error)}`,
			error: memoryFailure
				? `Browser transcription ran out of memory${device === "wasm" ? " using the CPU model" : !multilingual && lowMemory ? " even with the reduced-memory model" : ""}. ${phase === "loading-model" ? "Model loading failed before transcription started. Save your work, close this editor tab and reopen the project in a new tab to release browser memory, then retry." : "Save your work and reopen the editor to release browser memory, or retry with a shorter timeline."}${device === "wasm" ? " A browser with WebGPU and fp16 support can use the GPU instead." : ""} (${detail})`
				: `Browser transcription failed: ${detail}. Check model download access and browser GPU support, then retry.`,
		} satisfies WorkerResponse);
	} finally {
		if (!keepAlive) await transcriber?.dispose();
	}
};
