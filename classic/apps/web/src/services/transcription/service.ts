/** Browser execution adapter. Only public weights are cached; audio stays in RAM. */
import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
} from "@/transcription/types";
import type { WorkerMessage, WorkerResponse } from "./worker";

export function assertBrowserTranscriptionAvailable() {
	if (
		!globalThis.isSecureContext ||
		typeof Worker === "undefined" ||
		typeof WebAssembly === "undefined"
	)
		throw new Error(
			"Browser transcription requires HTTPS and a browser with WebAssembly and Web Workers.",
		);
}

export class TranscriptionService {
	async transcribe({
		audioData,
		language = "auto",
		signal,
		onProgress,
	}: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		signal?: AbortSignal;
		onProgress?: (progress: TranscriptionProgress) => void;
	}): Promise<TranscriptionResult> {
		assertBrowserTranscriptionAvailable();
		const account = window.__opencutAccountId;
		const controller = new AbortController();
		const aborted = () => controller.abort();
		const changed = () => {
			if (window.__opencutAccountId !== account) controller.abort();
		};
		signal?.addEventListener("abort", aborted, { once: true });
		window.addEventListener("pagehide", aborted);
		window.addEventListener("storage", changed);
		if (signal?.aborted) controller.abort();
		const timer = setInterval(changed, 250);
		try {
			const run = () =>
				this.run({
					audioData,
					language,
					signal: controller.signal,
					onProgress,
					account,
				});
			if (navigator.locks) {
				onProgress?.({
					status: "loading-model",
					progress: 0,
					message: "Waiting for this browser's transcription worker…",
				});
				// Batch frames/tabs share the GPU. Do not load several large models at once.
				return await navigator.locks.request(
					"opencut-browser-whisper",
					{ signal: controller.signal },
					run,
				);
			}
			return await run();
		} finally {
			clearInterval(timer);
			signal?.removeEventListener("abort", aborted);
			window.removeEventListener("pagehide", aborted);
			window.removeEventListener("storage", changed);
		}
	}

	private run({
		audioData,
		language,
		signal,
		onProgress,
		account,
	}: {
		audioData: Float32Array;
		language: TranscriptionLanguage;
		signal: AbortSignal;
		onProgress?: (progress: TranscriptionProgress) => void;
		account: string | null;
	}): Promise<TranscriptionResult> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
			let settled = false;
			const finish = (error?: Error, result?: TranscriptionResult) => {
				if (settled) return;
				settled = true;
				worker.terminate(); // Interrupts downloads/inference and releases account audio and GPU memory.
				signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve(result!);
			};
			const abort = () =>
				finish(new DOMException("Transcription cancelled", "AbortError"));
			signal.addEventListener("abort", abort, { once: true });
			worker.onerror = (event) =>
				finish(
					new Error(
						event.message ||
							"The browser transcription worker could not start.",
					),
				);
			worker.onmessageerror = () =>
				finish(
					new Error("The browser could not read the transcription result."),
				);
			worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
				if (signal.aborted || window.__opencutAccountId !== account) {
					abort();
					return;
				}
				if (settled) return;
				if (data.type === "progress") {
					try {
						onProgress?.(data.progress);
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				} else if (data.type === "complete") finish(undefined, data.result);
				else finish(new Error(data.error));
			};
			worker.postMessage(
				{ audio: audioData, language } satisfies WorkerMessage,
				[audioData.buffer],
			);
		});
	}
}

export const transcriptionService = new TranscriptionService();
