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
} from "@/transcription/models";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";
import { boundWhisperGpuOutputs } from "./gpu-lifetime";

export type WorkerMessage = { audio: Float32Array; language: string };
export type WorkerResponse =
	| { type: "progress"; progress: TranscriptionProgress }
	| { type: "complete"; result: TranscriptionResult }
	| { type: "error"; error: string };

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

self.onmessage = async ({
	data: { audio, language },
}: MessageEvent<WorkerMessage>) => {
	let transcriber: AutomaticSpeechRecognitionPipeline | undefined;
	try {
		const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
		const device = adapter?.features.has("shader-f16") ? "webgpu" : "wasm";
		const label =
			device === "webgpu"
				? "GPU · WebGPU"
				: "CPU · WebAssembly (WebGPU fp16 unavailable; slower)";
		report({
			status: "loading-model",
			progress: 0,
			message: `Loading ivrit-ai Large v3 Turbo on your ${label}. First download is approximately 1.6 GB…`,
		});
		const files = new Map<string, { loaded: number; total: number }>();
		let lastReport = 0;
		transcriber = (await pipeline<"automatic-speech-recognition">(
			"automatic-speech-recognition",
			device === "webgpu" ? BROWSER_WHISPER_MODEL : BROWSER_WHISPER_CPU_MODEL,
			{
				revision:
					device === "webgpu"
						? BROWSER_WHISPER_REVISION
						: BROWSER_WHISPER_CPU_REVISION,
				device,
				dtype:
					device === "webgpu"
						? { encoder_model: "fp16", decoder_model_merged: "q4" }
						: "q8",
				progress_callback: (info) => {
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
						message: `Loading ivrit-ai on your ${label} · ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB · downloaded weights are cached in this browser`,
					});
				},
			},
		)) as AutomaticSpeechRecognitionPipeline;
		if (device === "webgpu") boundWhisperGpuOutputs(transcriber.model);
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
			language: language === "auto" ? "he" : language,
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
		if (result.text.trim() && !words.length)
			throw new Error(
				"The browser model did not return timed words. Captions were not changed.",
			);
		if (words.length && words.every((word) => word.end <= word.start))
			throw new Error(
				"The browser model could not align the words to the audio. Captions were not changed.",
			);
		self.postMessage({
			type: "complete",
			result: {
				text: result.text,
				words,
				segments: words,
				language: language === "auto" ? "he" : language,
			},
		} satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "error",
			error: `Browser transcription failed: ${error instanceof Error ? error.message : "Unknown error"}. Check available memory, model download access and browser GPU support, then retry.`,
		} satisfies WorkerResponse);
	} finally {
		await transcriber?.dispose();
	}
};
