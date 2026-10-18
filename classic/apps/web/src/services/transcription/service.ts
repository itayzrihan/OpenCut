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

	/** One model, one bounded PCM window, one GPU lease for the complete job. */
	async withChunkSession<T>({
		signal,
		run,
	}: {
		signal: AbortSignal;
		run: (
			transcribe: (input: {
				load: () => Promise<Float32Array>;
				language: TranscriptionLanguage;
				onProgress?: (progress: TranscriptionProgress) => void;
			}) => Promise<TranscriptionResult>,
			signal: AbortSignal,
		) => Promise<T>;
	}): Promise<T> {
		assertBrowserTranscriptionAvailable();
		const account = window.__opencutAccountId;
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const abort = () => controller.abort();
		const changed = () => {
			if (window.__opencutAccountId !== account) abort();
		};
		window.addEventListener("pagehide", abort);
		const timer = setInterval(changed, 250);
		let worker: Worker | undefined;
		let windowsSinceRestart = 0;
		const execute = async () => {
			try {
				const result = await run(async ({ load, language, onProgress }) => {
					for (let attempt = 0; ; attempt++) {
						combined.throwIfAborted();
						changed();
						combined.throwIfAborted();
						// Bound ONNX/driver allocator lifetime even when tensors are disposed.
						// Cached model weights are reloaded only after the old worker exits.
						if (windowsSinceRestart >= 8) {
							worker?.terminate();
							worker = undefined;
							windowsSinceRestart = 0;
						}
						const audioData = await load();
						if (audioData.length > 90 * 16000)
							throw new Error(
								"Transcription window exceeds the bounded memory limit",
							);
						combined.throwIfAborted();
						worker ??= new Worker(new URL("./worker.ts", import.meta.url), {
							type: "module",
						});
						try {
							const result = await this.run({
								audioData,
								language,
								signal: combined,
								account,
								onProgress,
								lowMemory: true,
								residentWorker: worker,
							});
							windowsSinceRestart++;
							return result;
						} catch (error) {
							worker.terminate();
							worker = undefined;
							combined.throwIfAborted();
							if (
								attempt ||
								!/memory|allocat|worker|device.*lost/i.test(String(error))
							)
								throw error;
							onProgress?.({
								status: "transcribing",
								progress: 0,
								message:
									"Restarting the audio worker; completed sections are saved…",
							});
						}
					}
				}, combined);
				changed();
				combined.throwIfAborted();
				return result;
			} finally {
				worker?.terminate();
			}
		};
		try {
			return navigator.locks
				? await navigator.locks.request(
						"opencut-browser-whisper",
						{ signal: combined },
						execute,
					)
				: await execute();
		} finally {
			clearInterval(timer);
			window.removeEventListener("pagehide", abort);
		}
	}

	private run({
		audioData,
		language,
		signal,
		onProgress,
		account,
		lowMemory = false,
		residentWorker,
	}: {
		audioData: Float32Array;
		language: TranscriptionLanguage;
		signal: AbortSignal;
		onProgress?: (progress: TranscriptionProgress) => void;
		account: string | null;
		lowMemory?: boolean;
		residentWorker?: Worker;
	}): Promise<TranscriptionResult> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const worker =
				residentWorker ??
				new Worker(new URL("./worker.ts", import.meta.url), {
					type: "module",
				});
			let settled = false;
			let watchdog: ReturnType<typeof setTimeout>;
			const heartbeat = () => {
				clearTimeout(watchdog);
				watchdog = setTimeout(
					() =>
						finish({
							error: new Error(
								"Transcription worker stopped responding; retry will resume completed sections",
							),
						}),
					300000,
				);
			};
			const finish = ({
				error,
				result,
			}: {
				error?: Error;
				result?: TranscriptionResult;
			}) => {
				if (settled) return;
				settled = true;
				clearTimeout(watchdog);
				if (error || !residentWorker) worker.terminate();
				worker.onmessage = null;
				worker.onerror = null;
				worker.onmessageerror = null;
				signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve(result!);
			};
			const abort = () =>
				finish({
					error: new DOMException("Transcription cancelled", "AbortError"),
				});
			signal.addEventListener("abort", abort, { once: true });
			worker.onerror = (event) =>
				finish({
					error: new Error(
						event.message ||
							"The browser transcription worker could not start.",
					),
				});
			worker.onmessageerror = () =>
				finish({
					error: new Error(
						"The browser could not read the transcription result.",
					),
				});
			worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
				if (signal.aborted || window.__opencutAccountId !== account) {
					abort();
					return;
				}
				if (settled) return;
				heartbeat();
				if (data.type === "progress") {
					try {
						onProgress?.(data.progress);
					} catch (error) {
						finish({
							error: error instanceof Error ? error : new Error(String(error)),
						});
					}
				} else if (data.type === "retry-low-memory") {
					if (lowMemory) {
						finish({
							error: new Error(
								"Browser transcription ran out of memory after retry.",
							),
						});
						return;
					}
					settled = true;
					clearTimeout(watchdog);
					worker.terminate();
					signal.removeEventListener("abort", abort);
					try {
						onProgress?.({
							status: "loading-model",
							progress: 0,
							message:
								"The browser ran out of memory. Retrying once with a smaller quantized encoder…",
						});
						if (window.__opencutAccountId !== account)
							throw new DOMException("Account changed", "AbortError");
						resolve(
							this.run({
								audioData: data.audio,
								language,
								signal,
								onProgress,
								account,
								lowMemory: true,
							}),
						);
					} catch (error) {
						reject(error);
					}
				} else if (data.type === "complete")
					finish({ error: undefined, result: data.result });
				else {
					if (data.diagnostic)
						console.error("Transcription diagnostic", data.diagnostic);
					finish({ error: new Error(data.error) });
				}
			};
			try {
				heartbeat();
				worker.postMessage(
					{
						audio: audioData,
						language,
						lowMemory,
						...(residentWorker ? { keepAlive: true } : {}),
					} satisfies WorkerMessage,
					[audioData.buffer],
				);
			} catch (error) {
				finish({
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		});
	}
}

export const transcriptionService = new TranscriptionService();
