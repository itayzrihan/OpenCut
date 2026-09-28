/** Browser/Electron inference adapter. Text and audio never leave the device. */
import { KokoroTTS, type GenerateOptions } from "kokoro-js";
import { env } from "@huggingface/transformers";

export type SpeechRequest = {
	text: string;
	voice: NonNullable<GenerateOptions["voice"]>;
	device: "auto" | "wasm";
};
export type SpeechResponse =
	| { type: "status"; message: string }
	| { type: "complete"; audio: Blob; device: "webgpu" | "wasm" }
	| { type: "error"; message: string };

env.allowLocalModels = false;
env.useBrowserCache = true;
// These public model caches contain weights only, never account content.
let model: KokoroTTS | null = null;
let device: "webgpu" | "wasm" = "wasm";
let busy = false;
const report = (message: string) =>
	self.postMessage({ type: "status", message } satisfies SpeechResponse);

async function load(target: "webgpu" | "wasm") {
	report(
		`Loading cached speech model (${target === "webgpu" ? "GPU" : "CPU"})…`,
	);
	return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
		device: target,
		dtype: target === "webgpu" ? "fp32" : "q8",
		progress_callback: (progress) => {
			if (progress.status === "progress")
				report(`Downloading speech model: ${Math.round(progress.progress)}%`);
		},
	});
}

self.onmessage = async ({ data }: MessageEvent<SpeechRequest>) => {
	if (busy) return;
	busy = true;
	try {
		const text = data.text.trim();
		if (!text || text.length > 250)
			throw new Error("Enter 1–250 characters per voiceover clip.");
		// Kokoro's packaged phonemizer/voices support English. Never silently
		// pronounce Hebrew or another unsupported script as English.
		if (
			/[^\p{Script=Latin}\p{Number}\p{Punctuation}\p{Separator}\s]/u.test(text)
		)
			throw new Error(
				"These voices support English text. Other languages are not available yet.",
			);
		if (!model) {
			device =
				data.device === "auto" &&
				(await navigator.gpu?.requestAdapter().catch(() => null))
					? "webgpu"
					: "wasm";
			try {
				model = await load(device);
			} catch (error) {
				if (device !== "webgpu") throw error;
				report("GPU model could not start. Loading the CPU model…");
				device = "wasm";
				model = await load(device);
			}
		}
		report(`Generating on your ${device === "webgpu" ? "GPU" : "CPU"}…`);
		const audio = await model.generate(text, { voice: data.voice });
		const blob = audio.toBlob();
		if (blob.size > 32 * 1024 * 1024)
			throw new Error("Generated audio exceeds the clip limit.");
		self.postMessage({
			type: "complete",
			audio: blob,
			device,
		} satisfies SpeechResponse);
	} catch (error) {
		self.postMessage({
			type: "error",
			message:
				error instanceof Error ? error.message : "Speech generation failed",
		} satisfies SpeechResponse);
	} finally {
		busy = false;
	}
};
